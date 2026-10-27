/**
 * Small form helpers. Zenith covers text, textarea and select; dates and
 * numbers use native inputs styled like Zenith so the stored value is an
 * unambiguous "YYYY-MM-DD" / number (Zenith's DateInput formats to the
 * user's locale and its Range is a min/max popup, not a plain number box).
 */

import { Select, TextInput, Textarea } from "@geotab/zenith";
import { type ReactNode, useId } from "react";
import { clampNumber } from "../utils/format";

interface BaseProps {
  label: string;
  className?: string;
  disabled?: boolean;
  assistive?: string;
}

export function Field({ label, className, children, hint }: { label: string; className?: string; children: ReactNode; hint?: string }) {
  return (
    <div className={`mwo-field ${className ?? ""}`}>
      <span className="mwo-field-label">{label}</span>
      {children}
      {hint ? <span className="mwo-muted mwo-small">{hint}</span> : null}
    </div>
  );
}

export function TextField({ label, value, onChange, placeholder, className, disabled, assistive }: BaseProps & { value: string; onChange: (v: string) => void; placeholder?: string }) {
  return (
    <TextInput className={className} label={label} labelAlign="top" width="100%" value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} disabled={disabled} assistive={assistive} />
  );
}

export function TextAreaField({ label, value, onChange, rows = 3, className, disabled, placeholder }: BaseProps & { value: string; onChange: (v: string) => void; rows?: number; placeholder?: string }) {
  return <Textarea className={className} label={label} labelAlign="top" width="100%" value={value} onChange={(e) => onChange(e.target.value)} rows={rows} disabled={disabled} placeholder={placeholder} />;
}

export function SelectField<T extends string>({ label, value, onChange, options, className, disabled, placeholder }: BaseProps & { value: T | ""; onChange: (v: T) => void; options: Array<{ id: T; name: string }>; placeholder?: string }) {
  return (
    <Select
      className={className}
      label={label}
      labelAlign="top"
      width="100%"
      title={label}
      items={options.map((o) => ({ id: o.id, children: o.name }))}
      value={value || undefined}
      placeholder={placeholder}
      disabled={disabled}
      forceSelection
      onChange={(id) => {
        if (id != null && id !== "") onChange(id as T);
      }}
    />
  );
}

export function DateField({ label, value, onChange, className, disabled, hint }: BaseProps & { value: string | null; onChange: (v: string | null) => void; hint?: string }) {
  const id = useId();
  return (
    <Field label={label} className={className} hint={hint}>
      <input id={id} type="date" className="mwo-input" value={value ?? ""} disabled={disabled} onChange={(e) => onChange(e.target.value || null)} />
    </Field>
  );
}

export function NumberField({ label, value, onChange, className, disabled, hint, step = "any", min, placeholder, small }: BaseProps & { value: number | null; onChange: (v: number | null) => void; hint?: string; step?: number | "any"; min?: number; placeholder?: string; small?: boolean }) {
  const id = useId();
  return (
    <Field label={label} className={className} hint={hint}>
      <input
        id={id}
        type="number"
        inputMode="decimal"
        className={`mwo-input ${small ? "mwo-input-sm" : ""}`}
        value={value == null ? "" : String(value)}
        step={step}
        min={min}
        placeholder={placeholder}
        disabled={disabled}
        onChange={(e) => onChange(clampNumber(e.target.value))}
      />
    </Field>
  );
}
