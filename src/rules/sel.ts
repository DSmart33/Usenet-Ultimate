/**
 * Stream Expression Language (SEL)
 *
 * DSL compatible with community ranked-rules templates — evaluates
 * conditional / set-level expressions against a pool of streams. Used by
 * the ranked-rules engine to score candidates, and by user-written boolean
 * expressions that match single attributes.
 *
 * Two return shapes are supported:
 *   - Stream[] — set-level. Caller applies the expression's score to every
 *                stream in the returned array. This is how community
 *                ranked-rules templates work.
 *   - boolean  — per-stream. Caller applies the score to the current stream
 *                if the expression evaluated truthy against its attributes.
 *                This is our legacy shape.
 *
 * Grammar highlights:
 *   - /* ... *\/ block comments (stripped at tokenize)
 *   - Ternary: cond ? a : b
 *   - Arithmetic: + - * /
 *   - Comparison: == != < <= > >=
 *   - Logic: && / and, || / or, ! / not (both word and symbol forms)
 *   - Membership: x in [list]
 *   - Array literals: [a, b, c]
 *   - Function calls: func(arg1, arg2, ...)
 *   - String / number literals
 *   - Attribute access: stream.<field> (single-level, allowlisted)
 *   - Bare identifiers resolve to context variables (streams, queryType, ...)
 *
 * Security: no eval/Function, depth cap 32, strings ≤ 1KB, attribute access
 * limited to a strict allowlist.
 */

// ─── Attribute allowlist for stream.<x> access ────────────────────────

export const ALLOWED_ATTRIBUTES = [
  'resolution', 'codec', 'releaseGroup', 'visualTag', 'audioTag', 'videoTag',
  'edition', 'language', 'size', 'title', 'filename', 'indexer', 'age', 'seeders',
] as const;
export type AllowedAttribute = typeof ALLOWED_ATTRIBUTES[number];
const ALLOWED_SET = new Set<string>(ALLOWED_ATTRIBUTES);

// ─── Limits ──────────────────────────────────────────────────────────

const MAX_DEPTH = 32;
const MAX_STRING_LEN = 1024;
const MAX_EXPRESSION_LEN = 8192;

// ─── Tokenizer ────────────────────────────────────────────────────────

type TokenType = 'IDENT' | 'NUMBER' | 'STRING' | 'OP' | 'PUNCT' | 'EOF';

interface Token {
  type: TokenType;
  value: string;
  pos: number;
}

function tokenize(source: string): Token[] {
  if (source.length > MAX_EXPRESSION_LEN) {
    throw new SyntaxError(`Expression too long (${source.length} > ${MAX_EXPRESSION_LEN})`);
  }

  // Strip /* ... */ comments first. Community templates use these extensively
  // as named/reference markers — they must not be confused with division or
  // regex. Line comments (//) are not part of the grammar.
  source = source.replace(/\/\*[\s\S]*?\*\//g, ' ');

  const tokens: Token[] = [];
  let i = 0;
  const n = source.length;

  while (i < n) {
    const ch = source[i];

    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') { i++; continue; }

    if (ch === '(' || ch === ')' || ch === '[' || ch === ']' || ch === ',' || ch === '?' || ch === ':') {
      tokens.push({ type: 'PUNCT', value: ch, pos: i });
      i++;
      continue;
    }

    if (ch === '=' && source[i + 1] === '=') { tokens.push({ type: 'OP', value: '==', pos: i }); i += 2; continue; }
    if (ch === '!' && source[i + 1] === '=') { tokens.push({ type: 'OP', value: '!=', pos: i }); i += 2; continue; }
    if (ch === '<' && source[i + 1] === '=') { tokens.push({ type: 'OP', value: '<=', pos: i }); i += 2; continue; }
    if (ch === '>' && source[i + 1] === '=') { tokens.push({ type: 'OP', value: '>=', pos: i }); i += 2; continue; }
    if (ch === '&' && source[i + 1] === '&') { tokens.push({ type: 'OP', value: '&&', pos: i }); i += 2; continue; }
    if (ch === '|' && source[i + 1] === '|') { tokens.push({ type: 'OP', value: '||', pos: i }); i += 2; continue; }

    if (ch === '<' || ch === '>' || ch === '!' || ch === '+' || ch === '-' || ch === '*' || ch === '/') {
      tokens.push({ type: 'OP', value: ch, pos: i });
      i++;
      continue;
    }

    if (ch === '.') {
      tokens.push({ type: 'PUNCT', value: '.', pos: i });
      i++;
      continue;
    }

    if (ch === "'" || ch === '"') {
      const quote = ch;
      const start = i;
      i++;
      let s = '';
      while (i < n && source[i] !== quote) {
        if (source[i] === '\\' && i + 1 < n) {
          const esc = source[i + 1];
          if (esc === quote || esc === '\\') s += esc;
          else if (esc === 'n') s += '\n';
          else if (esc === 't') s += '\t';
          else if (esc === 'r') s += '\r';
          else s += esc;
          i += 2;
        } else {
          s += source[i];
          i++;
        }
        if (s.length > MAX_STRING_LEN) {
          throw new SyntaxError(`String literal exceeds ${MAX_STRING_LEN} chars at ${start}`);
        }
      }
      if (i >= n) throw new SyntaxError(`Unterminated string at ${start}`);
      i++;
      tokens.push({ type: 'STRING', value: s, pos: start });
      continue;
    }

    if (ch >= '0' && ch <= '9') {
      const start = i;
      while (i < n && source[i] >= '0' && source[i] <= '9') i++;
      if (source[i] === '.') {
        i++;
        while (i < n && source[i] >= '0' && source[i] <= '9') i++;
      }
      const suffixCh = source[i]?.toLowerCase();
      if (suffixCh === 'k' || suffixCh === 'm' || suffixCh === 'g' || suffixCh === 't') {
        i++;
        if (source[i]?.toLowerCase() === 'b') i++;
      }
      tokens.push({ type: 'NUMBER', value: source.slice(start, i), pos: start });
      continue;
    }

    if ((ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z') || ch === '_') {
      const start = i;
      while (i < n && ((source[i] >= 'a' && source[i] <= 'z') || (source[i] >= 'A' && source[i] <= 'Z') || (source[i] >= '0' && source[i] <= '9') || source[i] === '_')) {
        i++;
      }
      tokens.push({ type: 'IDENT', value: source.slice(start, i), pos: start });
      continue;
    }

    throw new SyntaxError(`Unexpected character '${ch}' at ${i}`);
  }

  tokens.push({ type: 'EOF', value: '', pos: n });
  return tokens;
}

// ─── AST types ────────────────────────────────────────────────────────

type AstNode =
  | { type: 'ternary'; cond: AstNode; then: AstNode; else_: AstNode }
  | { type: 'or';      left: AstNode; right: AstNode }
  | { type: 'and';     left: AstNode; right: AstNode }
  | { type: 'not';     expr: AstNode }
  | { type: 'cmp';     op: string; left: AstNode; right: AstNode }
  | { type: 'in';      left: AstNode; right: AstNode }
  | { type: 'arith';   op: '+' | '-' | '*' | '/'; left: AstNode; right: AstNode }
  | { type: 'neg';     expr: AstNode }
  | { type: 'call';    name: string; args: AstNode[] }
  | { type: 'attr';    name: AllowedAttribute }
  | { type: 'ident';   name: string }
  | { type: 'array';   items: AstNode[] }
  | { type: 'lit';     value: string | number | boolean | null };

export interface CompiledExpr {
  ast: AstNode;
  source: string;
}

// ─── Parser ───────────────────────────────────────────────────────────

function parseNumberLiteral(raw: string): number {
  const m = raw.match(/^([\d.]+)([kmgt])?(b)?$/i);
  if (!m) throw new SyntaxError(`Bad number literal '${raw}'`);
  const base = parseFloat(m[1]);
  const suffix = (m[2] || '').toLowerCase();
  let mul = 1;
  if (suffix === 'k') mul = 1024;
  else if (suffix === 'm') mul = 1024 * 1024;
  else if (suffix === 'g') mul = 1024 * 1024 * 1024;
  else if (suffix === 't') mul = 1024 * 1024 * 1024 * 1024;
  return base * mul;
}

class Parser {
  private tokens: Token[];
  private i = 0;
  private depth = 0;

  constructor(tokens: Token[]) { this.tokens = tokens; }

  private peek(off = 0): Token { return this.tokens[this.i + off]; }
  private consume(): Token { return this.tokens[this.i++]; }

  private accept(type: TokenType, value?: string): Token | null {
    const t = this.peek();
    if (t.type === type && (value === undefined || t.value === value)) return this.consume();
    return null;
  }

  private expect(type: TokenType, value?: string): Token {
    const t = this.accept(type, value);
    if (!t) {
      const got = this.peek();
      throw new SyntaxError(`Expected ${type}${value ? ` '${value}'` : ''} at ${got.pos}, got ${got.type} '${got.value}'`);
    }
    return t;
  }

  private enter() { if (++this.depth > MAX_DEPTH) throw new SyntaxError(`Expression nesting > ${MAX_DEPTH}`); }
  private leave() { this.depth--; }

  parseExpression(): AstNode {
    const node = this.parseTernary();
    if (this.peek().type !== 'EOF') {
      const t = this.peek();
      throw new SyntaxError(`Unexpected ${t.type} '${t.value}' at ${t.pos}`);
    }
    return node;
  }

  private parseTernary(): AstNode {
    const cond = this.parseOr();
    if (this.accept('PUNCT', '?')) {
      const then = this.parseTernary();
      this.expect('PUNCT', ':');
      const else_ = this.parseTernary();
      return { type: 'ternary', cond, then, else_ };
    }
    return cond;
  }

  private parseOr(): AstNode {
    let left = this.parseAnd();
    while (true) {
      if (this.accept('OP', '||')) {
        const right = this.parseAnd();
        left = { type: 'or', left, right };
        continue;
      }
      const t = this.peek();
      if (t.type === 'IDENT' && t.value === 'or') {
        this.consume();
        const right = this.parseAnd();
        left = { type: 'or', left, right };
        continue;
      }
      break;
    }
    return left;
  }

  private parseAnd(): AstNode {
    let left = this.parseNot();
    while (true) {
      if (this.accept('OP', '&&')) {
        const right = this.parseNot();
        left = { type: 'and', left, right };
        continue;
      }
      const t = this.peek();
      if (t.type === 'IDENT' && t.value === 'and') {
        this.consume();
        const right = this.parseNot();
        left = { type: 'and', left, right };
        continue;
      }
      break;
    }
    return left;
  }

  private parseNot(): AstNode {
    if (this.accept('OP', '!')) {
      return { type: 'not', expr: this.parseNot() };
    }
    const t = this.peek();
    if (t.type === 'IDENT' && t.value === 'not') {
      this.consume();
      return { type: 'not', expr: this.parseNot() };
    }
    return this.parseCmp();
  }

  private parseCmp(): AstNode {
    let left = this.parseAdditive();
    for (;;) {
      const t = this.peek();
      if (t.type === 'OP' && (t.value === '==' || t.value === '!=' || t.value === '<' || t.value === '<=' || t.value === '>' || t.value === '>=')) {
        this.consume();
        const right = this.parseAdditive();
        left = { type: 'cmp', op: t.value, left, right };
        continue;
      }
      if (t.type === 'IDENT' && t.value === 'in') {
        this.consume();
        const right = this.parseAdditive();
        left = { type: 'in', left, right };
        continue;
      }
      break;
    }
    return left;
  }

  private parseAdditive(): AstNode {
    let left = this.parseMult();
    while (this.peek().type === 'OP' && (this.peek().value === '+' || this.peek().value === '-')) {
      const op = this.consume().value as '+' | '-';
      const right = this.parseMult();
      left = { type: 'arith', op, left, right };
    }
    return left;
  }

  private parseMult(): AstNode {
    let left = this.parseUnary();
    while (this.peek().type === 'OP' && (this.peek().value === '*' || this.peek().value === '/')) {
      const op = this.consume().value as '*' | '/';
      const right = this.parseUnary();
      left = { type: 'arith', op, left, right };
    }
    return left;
  }

  private parseUnary(): AstNode {
    if (this.accept('OP', '-')) {
      return { type: 'neg', expr: this.parseUnary() };
    }
    return this.parsePrimary();
  }

  private parsePrimary(): AstNode {
    this.enter();
    try {
      if (this.accept('PUNCT', '(')) {
        const inner = this.parseTernary();
        this.expect('PUNCT', ')');
        return inner;
      }
      if (this.accept('PUNCT', '[')) {
        const items: AstNode[] = [];
        if (!this.accept('PUNCT', ']')) {
          do { items.push(this.parseTernary()); } while (this.accept('PUNCT', ','));
          this.expect('PUNCT', ']');
        }
        return { type: 'array', items };
      }
      const ident = this.accept('IDENT');
      if (ident) {
        // Function call?
        if (this.peek().type === 'PUNCT' && this.peek().value === '(') {
          this.consume();
          const args: AstNode[] = [];
          if (!this.accept('PUNCT', ')')) {
            do { args.push(this.parseTernary()); } while (this.accept('PUNCT', ','));
            this.expect('PUNCT', ')');
          }
          return { type: 'call', name: ident.value, args };
        }
        // stream.<attr> — legacy per-stream access
        if (ident.value === 'stream') {
          this.expect('PUNCT', '.');
          const field = this.expect('IDENT').value;
          if (!ALLOWED_SET.has(field)) {
            throw new SyntaxError(`Unknown attribute 'stream.${field}' at ${ident.pos}. Allowed: ${ALLOWED_ATTRIBUTES.join(', ')}`);
          }
          const next = this.peek();
          if (next.type === 'PUNCT' && next.value === '.') {
            throw new SyntaxError(`Deep attribute access not allowed at ${next.pos}`);
          }
          return { type: 'attr', name: field as AllowedAttribute };
        }
        if (ident.value === 'true')  return { type: 'lit', value: true  };
        if (ident.value === 'false') return { type: 'lit', value: false };
        if (ident.value === 'null')  return { type: 'lit', value: null  };
        // Bare identifier — resolved to a context variable at eval time
        return { type: 'ident', name: ident.value };
      }
      const s = this.accept('STRING');
      if (s) return { type: 'lit', value: s.value };
      const num = this.accept('NUMBER');
      if (num) return { type: 'lit', value: parseNumberLiteral(num.value) };
      const t = this.peek();
      throw new SyntaxError(`Expected expression at ${t.pos}, got ${t.type} '${t.value}'`);
    } finally {
      this.leave();
    }
  }
}

export function compile(expression: string): CompiledExpr {
  const tokens = tokenize(expression);
  const parser = new Parser(tokens);
  const ast = parser.parseExpression();
  return { ast, source: expression };
}

// ─── Evaluator ────────────────────────────────────────────────────────

/** Per-stream attribute map for legacy `stream.codec == '...'`-style expressions. */
export type StreamContext = Partial<Record<AllowedAttribute, string | number | null | undefined>>;

/** Opaque stream reference used by set-level functions. */
export interface StreamRef {
  /** Identity for set operations (Set key). Typically the source result object. */
  ref: unknown;
  /** Parsed metadata used by filter functions. */
  attrs: StreamContext;
  /** Regex rule names that matched this stream (template-style tag list). */
  tags: string[];
}

/** Evaluation context. */
export interface EvalContext {
  /** Full pool of streams (set-level functions read this via the `streams` identifier). */
  streams: StreamRef[];
  /** Attribute map for legacy per-stream `stream.<attr>` access. */
  stream?: StreamContext;
  /** Query-level constants: `queryType`, `isAnime`, etc. */
  constants: Record<string, unknown>;
  /** Built-in function registry. */
  functions: Record<string, SelFunction>;
}

export type SelFunction = (args: unknown[], ctx: EvalContext) => unknown;

function evalNode(node: AstNode, ctx: EvalContext): unknown {
  switch (node.type) {
    case 'lit':   return node.value;
    case 'array': return node.items.map(n => evalNode(n, ctx));

    case 'attr': {
      const s = ctx.stream ?? {};
      return s[node.name];
    }

    case 'ident': {
      if (node.name in ctx.constants) return ctx.constants[node.name];
      if (node.name === 'streams') return ctx.streams;
      // Unknown identifier — return undefined so downstream comparisons fail-open.
      return undefined;
    }

    case 'call': {
      const fn = ctx.functions[node.name];
      if (!fn) {
        // Unknown function — return empty array so set ops produce empties.
        return [];
      }
      const args = node.args.map(a => evalNode(a, ctx));
      return fn(args, ctx);
    }

    case 'ternary':
      return isTruthy(evalNode(node.cond, ctx))
        ? evalNode(node.then, ctx)
        : evalNode(node.else_, ctx);

    case 'or':  return isTruthy(evalNode(node.left, ctx)) || isTruthy(evalNode(node.right, ctx));
    case 'and': return isTruthy(evalNode(node.left, ctx)) && isTruthy(evalNode(node.right, ctx));
    case 'not': return !isTruthy(evalNode(node.expr, ctx));

    case 'neg': {
      const v = evalNode(node.expr, ctx);
      return typeof v === 'number' ? -v : 0;
    }

    case 'arith': {
      const l = Number(evalNode(node.left, ctx));
      const r = Number(evalNode(node.right, ctx));
      if (!Number.isFinite(l) || !Number.isFinite(r)) return 0;
      switch (node.op) {
        case '+': return l + r;
        case '-': return l - r;
        case '*': return l * r;
        case '/': return r === 0 ? 0 : l / r;
      }
      return 0;
    }

    case 'cmp': {
      const l = evalNode(node.left, ctx);
      const r = evalNode(node.right, ctx);
      if (l === undefined || l === null || r === undefined || r === null) {
        if (node.op === '==') return l === r;
        if (node.op === '!=') return l !== r;
        return false;
      }
      if (typeof l === 'number' && typeof r === 'number') {
        switch (node.op) {
          case '==': return l === r;
          case '!=': return l !== r;
          case '<':  return l < r;
          case '<=': return l <= r;
          case '>':  return l > r;
          case '>=': return l >= r;
        }
      }
      const ls = String(l);
      const rs = String(r);
      switch (node.op) {
        case '==': return ls.toLowerCase() === rs.toLowerCase();
        case '!=': return ls.toLowerCase() !== rs.toLowerCase();
        case '<':  return ls < rs;
        case '<=': return ls <= rs;
        case '>':  return ls > rs;
        case '>=': return ls >= rs;
      }
      return false;
    }

    case 'in': {
      const l = evalNode(node.left, ctx);
      const r = evalNode(node.right, ctx);
      if (!Array.isArray(r)) return false;
      if (l === undefined || l === null) return false;
      const ls = String(l).toLowerCase();
      for (const item of r) {
        if (item === undefined || item === null) continue;
        if (typeof l === 'number' && typeof item === 'number' && l === item) return true;
        if (String(item).toLowerCase() === ls) return true;
      }
      return false;
    }
  }
}

function isTruthy(v: unknown): boolean {
  if (v === null || v === undefined || v === false || v === 0 || v === '') return false;
  if (Array.isArray(v) && v.length === 0) return false;
  return true;
}

export function evaluate(compiled: CompiledExpr, ctx: EvalContext): unknown {
  return evalNode(compiled.ast, ctx);
}
