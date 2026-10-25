import * as React from "react";

import { cn } from "@/lib/utils";

function Textarea({ className, ...props }: React.ComponentProps<"textarea">) {
  return (
    <textarea
      data-slot="textarea"
      className={cn(
        "flex min-h-20 w-full min-w-0 rounded-md border border-paper-300 bg-paper-50 px-3 py-2 text-sm text-ink-900 shadow-none outline-none transition-colors placeholder:text-ink-500 focus-visible:border-seal-500 focus-visible:ring-2 focus-visible:ring-seal-500/30 disabled:cursor-not-allowed disabled:opacity-50",
        className,
      )}
      {...props}
    />
  );
}

export { Textarea };
