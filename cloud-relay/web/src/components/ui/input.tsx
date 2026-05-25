import type { InputHTMLAttributes } from "react";
import { cn } from "../../lib";

export function Input({ className, ...props }: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      className={cn(
        "flex h-9 w-full rounded-md border border-zinc-300 bg-white px-3 py-1 text-sm shadow-sm outline-none transition-colors placeholder:text-zinc-400 focus-visible:ring-1 focus-visible:ring-zinc-950",
        className
      )}
      {...props}
    />
  );
}
