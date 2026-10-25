import * as React from "react";

import { cn } from "@/lib/utils";

function Input({ className, type, ...props }: React.ComponentProps<"input">) {
  return (
    <input
      type={type}
      data-slot="input"
      className={cn(
        "flex h-9 w-full min-w-0 rounded-md border border-paper-300 bg-paper-50 px-3 py-1 text-sm text-ink-900 shadow-none outline-none transition-colors placeholder:text-ink-500 focus-visible:border-seal-500 focus-visible:ring-2 focus-visible:ring-seal-500/30 disabled:cursor-not-allowed disabled:opacity-50",
        className,
      )}
      {...props}
    />
  );
}

export { Input };
