import { useId, type ComponentProps, type ReactNode } from "react";
import { cn } from "@/lib/utils";
export function Input({ className, ...props }: ComponentProps<"input">) {
  return <input className={cn("field", className)} {...props} />;
}
export function Textarea({ className, ...props }: ComponentProps<"textarea">) {
  return (
    <textarea className={cn("field min-h-20 resize-y", className)} {...props} />
  );
}
export function Select({ className, ...props }: ComponentProps<"select">) {
  return <select className={cn("field", className)} {...props} />;
}
export function Field({
  label,
  ...props
}: ComponentProps<"input"> & { label: string }) {
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
