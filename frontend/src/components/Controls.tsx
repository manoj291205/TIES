import { useId, useState } from "react";
import type { CSSProperties, ChangeEvent, ReactNode } from "react";
import { cx } from "../lib/format";
import { Icon, IconName, Spinner } from "./Icon";

export interface ButtonProps {
  /** One `primary` per view; `pay` only for Claim. */
  variant?: "primary" | "secondary" | "ghost" | "pay" | "danger";
  size?: "sm" | "md" | "lg";
  icon?: IconName;
  iconRight?: IconName;
  loading?: boolean;
  disabled?: boolean;
  block?: boolean;
  title?: string;
  type?: "button" | "submit";
  className?: string;
  style?: CSSProperties;
  onClick?: () => void;
  children?: ReactNode;
}

export function Button({
  variant = "primary",
  size = "md",
  icon,
  iconRight,
  loading,
  disabled,
  block,
  title,
  type = "button",
  className,
  style,
  onClick,
  children,
}: ButtonProps) {
  return (
    <button
      type={type}
      className={cx(
        "ties-btn",
        `ties-btn--${variant}`,
        size !== "md" && `ties-btn--${size}`,
        block && "ties-btn--block",
        className,
      )}
      disabled={disabled || loading}
      aria-busy={loading ? true : undefined}
      onClick={onClick}
      title={title}
      style={style}
    >
      {loading ? <Spinner /> : icon ? <Icon name={icon} /> : null}
      {children}
      {iconRight ? <Icon name={iconRight} /> : null}
    </button>
  );
}

export interface TextFieldProps {
  label?: string;
  value?: string;
  placeholder?: string;
  hint?: string;
  error?: string;
  prefix?: string;
  suffix?: string;
  /** Mono font and a decimal keyboard: amounts, addresses, hashes. */
  mono?: boolean;
  readOnly?: boolean;
  id?: string;
  style?: CSSProperties;
  onChange?: (value: string) => void;
}

export function TextField({
  label,
  value,
  placeholder,
  hint,
  error,
  prefix,
  suffix,
  mono,
  readOnly,
  id,
  style,
  onChange,
}: TextFieldProps) {
  const auto = useId();
  const fieldId = id ?? auto;
  return (
    <div className="ties-field" style={style}>
      {label ? (
        <label className="ties-field__label" htmlFor={fieldId}>
          {label}
        </label>
      ) : null}
      <div
        className={cx(
          "ties-input",
          mono && "ties-input--mono",
          error && "ties-input--error",
          readOnly && "ties-input--ro",
        )}
      >
        {prefix ? <span className="ties-input__affix">{prefix}</span> : null}
        <input
          id={fieldId}
          value={value}
          placeholder={placeholder}
          readOnly={readOnly}
          aria-invalid={error ? true : undefined}
          inputMode={mono ? "decimal" : undefined}
          onChange={(e: ChangeEvent<HTMLInputElement>) => onChange?.(e.target.value)}
        />
        {suffix ? <span className="ties-input__affix">{suffix}</span> : null}
      </div>
      {error ? (
        <div className="ties-field__error" role="alert">
          <Icon name="alert" size={14} />
          {error}
        </div>
      ) : hint ? (
        <div className="ties-field__hint">{hint}</div>
      ) : null}
    </div>
  );
}

export interface SegmentedOption {
  value: string;
  label: string;
  icon?: IconName;
  count?: number;
}

export interface SegmentedControlProps {
  label: string;
  options: SegmentedOption[];
  /** Controlled value; leave undefined for an uncontrolled control. */
  value?: string;
  onChange?: (value: string) => void;
}

export function SegmentedControl({ label, options, value, onChange }: SegmentedControlProps) {
  const [inner, setInner] = useState(options[0]?.value);
  const current = value ?? inner;
  return (
    <div className="ties-seg" role="group" aria-label={label}>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          aria-pressed={o.value === current}
          onClick={() => {
            setInner(o.value);
            onChange?.(o.value);
          }}
        >
          {o.icon ? <Icon name={o.icon} size={14} /> : null}
          {o.label}
          {o.count != null ? (
            <span className="ties-mono ties-subtle" style={{ fontSize: 11 }}>
              {o.count}
            </span>
          ) : null}
        </button>
      ))}
    </div>
  );
}
