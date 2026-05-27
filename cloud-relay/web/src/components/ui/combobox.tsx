import * as React from "react";
import { Check, ChevronDown, Search, X } from "lucide-react";
import { cn } from "@/lib/utils";

export type ComboboxOption = {
  value: string;
  label: string;
  disabled?: boolean;
};

type SingleProps = {
  options: ComboboxOption[];
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  disabled?: boolean;
  className?: string;
};

type MultiProps = {
  options: ComboboxOption[];
  value: string[];
  onChange: (value: string[]) => void;
  placeholder?: string;
  disabled?: boolean;
  className?: string;
};

function useOutsideClick(ref: React.RefObject<HTMLElement | null>, onOutside: () => void) {
  React.useEffect(() => {
    const handler = (event: MouseEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node)) onOutside();
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [ref, onOutside]);
}

function Combobox({ options, value, onChange, placeholder = "Select", disabled, className }: SingleProps) {
  const [open, setOpen] = React.useState(false);
  const [query, setQuery] = React.useState("");
  const rootRef = React.useRef<HTMLDivElement>(null);
  useOutsideClick(rootRef, () => setOpen(false));

  const selected = options.find(option => option.value === value);
  const visible = options.filter(option => option.label.toLowerCase().includes(query.toLowerCase()));

  return (
    <div ref={rootRef} className={cn("combobox", className)}>
      <button type="button" className="combobox-trigger" disabled={disabled} onClick={() => setOpen(next => !next)}>
        <span>{selected?.label || placeholder}</span>
        <ChevronDown size={14} />
      </button>
      {open && (
        <div className="combobox-popover">
          <div className="combobox-search">
            <Search size={14} />
            <input value={query} onChange={event => setQuery(event.target.value)} placeholder="Search" autoFocus />
          </div>
          <div className="combobox-options">
            {visible.map(option => (
              <button
                type="button"
                key={option.value}
                className="combobox-option"
                disabled={option.disabled}
                onClick={() => {
                  onChange(option.value);
                  setOpen(false);
                  setQuery("");
                }}
              >
                <span>{option.label}</span>
                {option.value === value && <Check size={14} />}
              </button>
            ))}
            {!visible.length && <div className="combobox-empty">No results</div>}
          </div>
        </div>
      )}
    </div>
  );
}

function MultiCombobox({ options, value, onChange, placeholder = "Select", disabled, className }: MultiProps) {
  const [open, setOpen] = React.useState(false);
  const [query, setQuery] = React.useState("");
  const rootRef = React.useRef<HTMLDivElement>(null);
  useOutsideClick(rootRef, () => setOpen(false));

  const visible = options.filter(option => option.label.toLowerCase().includes(query.toLowerCase()));
  const selected = options.filter(option => value.includes(option.value));
  const label = selected.length ? `${selected.length} selected` : placeholder;

  const toggle = (option: ComboboxOption) => {
    if (option.disabled) return;
    onChange(value.includes(option.value) ? value.filter(item => item !== option.value) : [...value, option.value]);
  };

  return (
    <div ref={rootRef} className={cn("combobox", className)}>
      <button type="button" className="combobox-trigger" disabled={disabled} onClick={() => setOpen(next => !next)}>
        <span>{label}</span>
        <ChevronDown size={14} />
      </button>
      {selected.length > 0 && (
        <div className="combobox-selected">
          {selected.map(option => (
            <span key={option.value} className="combobox-chip">
              {option.label}
              <button type="button" onClick={() => onChange(value.filter(item => item !== option.value))} disabled={disabled}>
                <X size={11} />
              </button>
            </span>
          ))}
        </div>
      )}
      {open && (
        <div className="combobox-popover">
          <div className="combobox-search">
            <Search size={14} />
            <input value={query} onChange={event => setQuery(event.target.value)} placeholder="Search" autoFocus />
          </div>
          <div className="combobox-options">
            {visible.map(option => {
              const active = value.includes(option.value);
              return (
                <button
                  type="button"
                  key={option.value}
                  className="combobox-option"
                  disabled={option.disabled}
                  onClick={() => toggle(option)}
                >
                  <span>{option.label}</span>
                  {active && <Check size={14} />}
                </button>
              );
            })}
            {!visible.length && <div className="combobox-empty">No results</div>}
          </div>
        </div>
      )}
    </div>
  );
}

export { Combobox, MultiCombobox };
