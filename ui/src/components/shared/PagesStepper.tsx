import { useCallback, useRef } from 'react';
import { useHoldRepeat } from '../../hooks/useHoldRepeat';
import { TimeoutStepper } from './TimeoutStepper';

interface PagesStepperProps {
  value: number;
  defaultValue?: number;
  min?: number;
  max?: number;
  onChange: (next: number) => void;
  compact?: boolean;
}

export function PagesStepper({
  value,
  defaultValue = 3,
  min = 1,
  max = 10,
  onChange,
  compact = false,
}: PagesStepperProps) {
  // Read latest value from a ref so the hold-repeat tick (which captures
  // `action` at press time) always sees current state. Without this, deps
  // on `value` would re-create `action`, but the running tick keeps calling
  // the original closure and pins the value at +/-1.
  const valueRef = useRef(value);
  valueRef.current = value;
  const dec = useHoldRepeat(useCallback(() => onChange(Math.max(min, valueRef.current - 1)), [onChange, min]));
  const inc = useHoldRepeat(useCallback(() => onChange(Math.min(max, valueRef.current + 1)), [onChange, max]));
  return (
    <TimeoutStepper
      value={value}
      defaultValue={defaultValue}
      min={min}
      max={max}
      decProps={dec}
      incProps={inc}
      onChange={onChange}
      unit="pages"
      ariaLabel="additional pages"
      compact={compact}
    />
  );
}
