import * as React from "react";
import { MdAdd, MdRemove } from "react-icons/md";
import { Button } from "./button";
import { Input } from "./input";

export interface NumberInputProps
  extends Omit<React.InputHTMLAttributes<HTMLInputElement>, "onChange"> {
  value: number;
  onChange: (value: number) => void;
  min?: number;
  max?: number;
  step?: number;
}

export const NumberInput = React.forwardRef<HTMLInputElement, NumberInputProps>(
  ({ className, value, onChange, min = -Infinity, max = Infinity, step = 1, ...props }, ref) => {
    const handleIncrement = () => {
      const newValue = value + step;
      if (newValue <= max) onChange(newValue);
    };

    const handleDecrement = () => {
      const newValue = value - step;
      if (newValue >= min) onChange(newValue);
    };

    const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
      const val = parseInt(e.target.value);
      if (!isNaN(val)) onChange(val);
      else onChange(0);
    };

    const handleBlur = (e: React.FocusEvent<HTMLInputElement>) => {
      if (value < min) onChange(min);
      else if (value > max) onChange(max);
      props.onBlur?.(e);
    };

    return (
      <div className={`flex items-center ${className || ""}`}>
        <Button
          type="button"
          variant="outline"
          size="icon"
          onClick={handleDecrement}
          disabled={value <= min}
          className="rounded-r-none shrink-0 border-r-0 focus-visible:z-10 bg-muted/20"
        >
          <MdRemove className="text-sm" />
        </Button>
        <Input
          type="number"
          ref={ref}
          value={value === 0 && min > 0 ? "" : value}
          onChange={handleChange}
          onBlur={handleBlur}
          className="rounded-none text-center px-1 w-full focus-visible:z-10 [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
          min={min}
          max={max}
          step={step}
          {...props}
        />
        <Button
          type="button"
          variant="outline"
          size="icon"
          onClick={handleIncrement}
          disabled={value >= max}
          className="rounded-l-none shrink-0 border-l-0 focus-visible:z-10 bg-muted/20"
        >
          <MdAdd className="text-sm" />
        </Button>
      </div>
    );
  },
);
NumberInput.displayName = "NumberInput";
