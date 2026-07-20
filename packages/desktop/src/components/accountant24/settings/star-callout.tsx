// The settings sidebar's star-the-repo callout. Rendered in the SidebarFooter;
// opens the repo in the system browser via the window-open handler.

import { StarIcon } from "lucide-react";

export function StarCallout() {
  return (
    <a
      href="https://github.com/machulav/accountant24"
      target="_blank"
      rel="noreferrer"
      className="flex items-center gap-2 rounded-xl border border-primary/30 bg-primary/10 px-3 py-2.5 transition-colors hover:bg-primary/15"
    >
      <StarIcon className="size-4 shrink-0 fill-primary text-primary" />
      {/* Same type scale as the sidebar UpdateBanner: text-sm medium title
          over a text-xs muted subtitle, leading-tight. */}
      <span className="grid min-w-0 gap-0.5 leading-tight">
        <span className="text-sm font-medium">Enjoying the app?</span>
        <span className="text-muted-foreground text-xs">Star us on GitHub</span>
      </span>
    </a>
  );
}
