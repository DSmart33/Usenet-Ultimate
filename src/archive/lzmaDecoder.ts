/**
 * Minimal LZMA1 decoder for decompressing 7z encoded headers.
 * Based on the LZMA SDK reference implementation (public domain, Igor Pavlov).
 *
 * Only implements decompression. Handles raw LZMA1 streams with provided properties.
 */

export function decompressLZMA1(
  compressedData: Buffer,
  properties: Buffer,
  uncompressedSize: number
): Buffer {
  const propByte = properties[0];
  const lc = propByte % 9;
  const remainder = Math.floor(propByte / 9);
  const lp = remainder % 5;
  const pb = Math.floor(remainder / 5);

  const dictionarySize = properties.readUInt32LE(1);

  const rc = new RangeDecoder(compressedData);
  const decoder = new LZMADecoder(lc, lp, pb, dictionarySize, uncompressedSize, rc);

  return decoder.decode();
}

class RangeDecoder {
  private data: Buffer;
  private pos: number;
  public range: number;
  public code: number;

  constructor(data: Buffer) {
    this.data = data;
    this.pos = 0;
    this.range = 0xFFFFFFFF;
    this.code = 0;

    // First byte of LZMA stream is always 0x00
    this.pos++;

    // Read initial 4 bytes into code
    for (let i = 0; i < 4; i++) {
      this.code = ((this.code << 8) | this.readByte()) >>> 0;
    }
  }

  private readByte(): number {
    if (this.pos < this.data.length) {
      return this.data[this.pos++];
    }
    return 0;
  }

  normalize(): void {
    if ((this.range >>> 0) < 0x01000000) {
      this.range = (this.range << 8) >>> 0;
      this.code = ((this.code << 8) | this.readByte()) >>> 0;
    }
  }

  decodeBit(probs: Uint16Array, index: number): number {
    this.normalize();
    const prob = probs[index];
    const bound = ((this.range >>> 11) * prob) >>> 0;

    if ((this.code >>> 0) < bound) {
      this.range = bound;
      probs[index] = (prob + ((2048 - prob) >> 5)) & 0xFFFF;
      return 0;
    } else {
      this.range = (this.range - bound) >>> 0;
      this.code = (this.code - bound) >>> 0;
      probs[index] = (prob - (prob >> 5)) & 0xFFFF;
      return 1;
    }
  }

  decodeDirectBits(numBits: number): number {
    let result = 0;
    for (let i = 0; i < numBits; i++) {
      this.normalize();
      this.range = (this.range >>> 1) >>> 0;
      const t = ((this.code - this.range) >>> 31) ^ 1;
      this.code = (this.code - (this.range & (0 - t))) >>> 0;
      result = (result << 1) | t;
    }
    return result;
  }
}

const kNumPosBitsMax = 4;
const kNumStates = 12;
const kNumLenToPosStates = 4;
const kNumAlignBits = 4;
const kStartPosModelIndex = 4;
const kEndPosModelIndex = 14;
const kNumFullDistances = 1 << (kEndPosModelIndex >> 1);
const kMatchMinLen = 2;

function initProbs(size: number): Uint16Array {
  const probs = new Uint16Array(size);
  probs.fill(1024);
  return probs;
}

class BitTreeDecoder {
  numBits: number;
  probs: Uint16Array;

  constructor(numBits: number) {
    this.numBits = numBits;
    this.probs = initProbs(1 << numBits);
  }

  decode(rc: RangeDecoder): number {
    let m = 1;
    for (let i = 0; i < this.numBits; i++) {
      m = (m << 1) | rc.decodeBit(this.probs, m);
    }
    return m - (1 << this.numBits);
  }

  reverseDecode(rc: RangeDecoder): number {
    return BitTreeDecoder.reverseDecodeStatic(this.probs, 0, this.numBits, rc);
  }

  static reverseDecodeStatic(probs: Uint16Array, offset: number, numBits: number, rc: RangeDecoder): number {
    let m = 1;
    let symbol = 0;
    for (let i = 0; i < numBits; i++) {
      const bit = rc.decodeBit(probs, offset + m);
      m = (m << 1) | bit;
      symbol |= bit << i;
    }
    return symbol;
  }
}

class LenDecoder {
  choice: Uint16Array;
  lowCoder: BitTreeDecoder[];
  midCoder: BitTreeDecoder[];
  highCoder: BitTreeDecoder;

  constructor() {
    this.choice = initProbs(2);
    this.lowCoder = [];
    this.midCoder = [];
    for (let i = 0; i < (1 << kNumPosBitsMax); i++) {
      this.lowCoder.push(new BitTreeDecoder(3));
      this.midCoder.push(new BitTreeDecoder(3));
    }
    this.highCoder = new BitTreeDecoder(8);
  }

  decode(rc: RangeDecoder, posState: number): number {
    if (rc.decodeBit(this.choice, 0) === 0) {
      return this.lowCoder[posState].decode(rc);
    }
    if (rc.decodeBit(this.choice, 1) === 0) {
      return 8 + this.midCoder[posState].decode(rc);
    }
    return 16 + this.highCoder.decode(rc);
  }
}

class LZMADecoder {
  private lc: number;
  private lp: number;
  private pb: number;
  private dictSize: number;
  private uncompSize: number;
  private rc: RangeDecoder;

  private isMatch: Uint16Array;
  private isRep: Uint16Array;
  private isRepG0: Uint16Array;
  private isRepG1: Uint16Array;
  private isRepG2: Uint16Array;
  private isRep0Long: Uint16Array;
  private litProbs: Uint16Array;
  private posSlotDecoder: BitTreeDecoder[];
  private posDecoders: Uint16Array;
  private posAlignDecoder: BitTreeDecoder;
  private lenDecoder: LenDecoder;
  private repLenDecoder: LenDecoder;

  constructor(lc: number, lp: number, pb: number, dictSize: number, uncompSize: number, rc: RangeDecoder) {
    this.lc = lc;
    this.lp = lp;
    this.pb = pb;
    this.dictSize = Math.max(dictSize, 1);
    this.uncompSize = uncompSize;
    this.rc = rc;

    this.isMatch = initProbs(kNumStates << kNumPosBitsMax);
    this.isRep = initProbs(kNumStates);
    this.isRepG0 = initProbs(kNumStates);
    this.isRepG1 = initProbs(kNumStates);
    this.isRepG2 = initProbs(kNumStates);
    this.isRep0Long = initProbs(kNumStates << kNumPosBitsMax);
    this.litProbs = initProbs(768 << (lc + lp));
    this.posSlotDecoder = [];
    for (let i = 0; i < kNumLenToPosStates; i++) {
      this.posSlotDecoder.push(new BitTreeDecoder(6));
    }
    this.posDecoders = initProbs(kNumFullDistances - kEndPosModelIndex);
    this.posAlignDecoder = new BitTreeDecoder(kNumAlignBits);
    this.lenDecoder = new LenDecoder();
    this.repLenDecoder = new LenDecoder();
  }

  decode(): Buffer {
    const output: number[] = [];
    let state = 0;
    let rep0 = 0, rep1 = 0, rep2 = 0, rep3 = 0;

    while (output.length < this.uncompSize) {
      const posState = output.length & ((1 << this.pb) - 1);

      if (this.rc.decodeBit(this.isMatch, (state << kNumPosBitsMax) + posState) === 0) {
        // Literal
        const prevByte = output.length > 0 ? output[output.length - 1] : 0;
        const litState = ((output.length & ((1 << this.lp) - 1)) << this.lc) + (prevByte >> (8 - this.lc));
        const probsOffset = 768 * litState;

        let symbol = 1;

        if (state >= 7) {
          let matchByte = 0;
          const matchPos = output.length - rep0 - 1;
          if (matchPos >= 0) {
            matchByte = output[matchPos];
          }

          do {
            const matchBit = (matchByte >> 7) & 1;
            matchByte <<= 1;
            const bit = this.rc.decodeBit(this.litProbs, probsOffset + ((1 + matchBit) << 8) + symbol);
            symbol = (symbol << 1) | bit;
            if (matchBit !== bit) break;
          } while (symbol < 0x100);
        }

        while (symbol < 0x100) {
          symbol = (symbol << 1) | this.rc.decodeBit(this.litProbs, probsOffset + symbol);
        }

        output.push(symbol & 0xFF);

        if (state < 4) state = 0;
        else if (state < 10) state -= 3;
        else state -= 6;

      } else {
        // Match or rep
        let len: number;

        if (this.rc.decodeBit(this.isRep, state) === 0) {
          // Simple match
          rep3 = rep2;
          rep2 = rep1;
          rep1 = rep0;

          len = kMatchMinLen + this.lenDecoder.decode(this.rc, posState);
          state = state < 7 ? 7 : 10;

          const posSlot = this.posSlotDecoder[Math.min(len - kMatchMinLen, kNumLenToPosStates - 1)].decode(this.rc);

          if (posSlot < kStartPosModelIndex) {
            rep0 = posSlot;
          } else {
            const numDirectBits = (posSlot >> 1) - 1;
            rep0 = (2 | (posSlot & 1)) << numDirectBits;

            if (posSlot < kEndPosModelIndex) {
              rep0 += BitTreeDecoder.reverseDecodeStatic(
                this.posDecoders,
                rep0 - posSlot - 1,
                numDirectBits,
                this.rc
              );
            } else {
              rep0 += this.rc.decodeDirectBits(numDirectBits - kNumAlignBits) << kNumAlignBits;
              rep0 += this.posAlignDecoder.reverseDecode(this.rc);
            }
          }

          if (rep0 === 0xFFFFFFFF) break; // End marker

          if (rep0 >= output.length) {
            throw new Error(`LZMA: invalid distance ${rep0} at position ${output.length}`);
          }

        } else {
          // Rep match
          if (this.rc.decodeBit(this.isRepG0, state) === 0) {
            if (this.rc.decodeBit(this.isRep0Long, (state << kNumPosBitsMax) + posState) === 0) {
              // ShortRep
              state = state < 7 ? 9 : 11;
              const pos = output.length - rep0 - 1;
              output.push(pos >= 0 ? output[pos] : 0);
              continue;
            }
          } else {
            let dist: number;
            if (this.rc.decodeBit(this.isRepG1, state) === 0) {
              dist = rep1;
            } else {
              if (this.rc.decodeBit(this.isRepG2, state) === 0) {
                dist = rep2;
              } else {
                dist = rep3;
                rep3 = rep2;
              }
              rep2 = rep1;
            }
            rep1 = rep0;
            rep0 = dist;
          }

          len = kMatchMinLen + this.repLenDecoder.decode(this.rc, posState);
          state = state < 7 ? 8 : 11;
        }

        // Copy from dictionary
        for (let i = 0; i < len && output.length < this.uncompSize; i++) {
          const pos = output.length - rep0 - 1;
          output.push(pos >= 0 ? output[pos] : 0);
        }
      }
    }

    return Buffer.from(output);
  }
}
