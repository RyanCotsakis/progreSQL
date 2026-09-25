import { useId, useState, type ComponentProps, type ReactNode } from "react";
import { ChevronUp, ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";
type InputProps = ComponentProps<"input"> & {
  increment?: number;
  onValueChange?: (value: string) => void;
};
export function Input({
  className,
  increment,
  onValueChange,
  onChange,
  ...props
}: InputProps) {
  const [draft, setDraft] = useState(String(props.defaultValue ?? ""));
  const value = props.value === undefined ? draft : String(props.value);
  const change = (next: string) => {
    setDraft(next);
    onValueChange?.(next);
  };
  const adjust = (direction: number) => {
    const current = value === "" ? 0 : Number(value);
    if (!Number.isFinite(current)) return;
    const next = Math.min(
      Number(props.max ?? Infinity),
      Math.max(
        Number(props.min ?? -Infinity),
        Number((current + direction * increment!).toPrecision(15)),
      ),
    );
    change(String(next));
  };
  const input = (
    <input
      {...props}
      className={cn(
        "field",
        increment &&
          "pr-7 appearance-none [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none [-moz-appearance:textfield]",
        className,
      )}
      {...(increment ? { value, defaultValue: undefined, step: "any" } : {})}
      onChange={(event) => {
        change(event.target.value);
        onChange?.(event);
      }}
      onKeyDown={(event) => {
        props.onKeyDown?.(event);
        if (
          increment &&
          !event.defaultPrevented &&
          !props.disabled &&
          !props.readOnly &&
          (event.key === "ArrowUp" || event.key === "ArrowDown")
        ) {
          event.preventDefault();
          adjust(event.key === "ArrowUp" ? 1 : -1);
        }
      }}
    />
  );
  if (!increment) return input;
  const label = props["aria-label"] || props.name || "value";
  return (
    <div className="relative min-w-0">
      {input}
      <div className="absolute right-1 inset-y-1 flex flex-col">
        {[1, -1].map((direction) => (
          <button
            key={direction}
            type="button"
            disabled={props.disabled || props.readOnly}
            aria-label={`${direction === 1 ? "Increase" : "Decrease"} ${label} by ${increment} kg`}
            className="flex flex-1 items-center justify-center rounded px-1 text-muted-foreground hover:bg-muted focus-visible:outline"
            onClick={() => adjust(direction)}
          >
            {direction === 1 ? (
              <ChevronUp size={14} />
            ) : (
              <ChevronDown size={14} />
            )}
          </button>
        ))}
      </div>
    </div>
  );
}
export function Textarea({ className, ...props }: ComponentProps<"textarea">) {
  return (
    <textarea className={cn("field min-h-20 resize-y", className)} {...props} />
  );
}
export function Select({ className, ...props }: ComponentProps<"select">) {
  return <select className={cn("field", className)} {...props} />;
}
export function Field({ label, ...props }: InputProps & { label: string }) {
  const id = useId();
  return (
    <div className="space-y-1.5">
      <label htmlFor={id} className="text-sm font-medium">
        {label}
      </label>
      <Input id={id} {...props} />
    </div>
  );
}
export function Card({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <section
      className={cn(
        "min-w-0 rounded-xl border bg-card p-5 shadow-[0_1px_3px_0_rgb(0_0_0/0.025)] sm:p-6",
        className,
      )}
    >
      {children}
    </section>
  );
}
