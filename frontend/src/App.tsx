import { useState } from "react";
import { FolderOpen, Layers } from "lucide-react";
import { FileBrowser } from "@/components/FileBrowser";
import { Sessions } from "@/components/Sessions";
import { Toaster } from "@/components/ui/toaster";
import { cn } from "@/lib/utils";

type Tab = "browse" | "sessions";

export default function App() {
  const [tab, setTab] = useState<Tab>("browse");
  const [launchDir, setLaunchDir] = useState("/home/pi");

  const handleLaunch = (dir: string) => {
    setLaunchDir(dir);
    setTab("sessions");
  };

  const NAV = [
    { id: "browse" as Tab, label: "Browse", icon: FolderOpen },
    { id: "sessions" as Tab, label: "Sessions", icon: Layers },
  ];

  return (
    <div className="flex flex-col h-[100dvh] bg-background text-foreground max-w-lg mx-auto">
      {/* Header */}
      <header className="flex items-center px-4 h-14 border-b bg-card">
        <h1 className="font-semibold tracking-tight">Launchpad</h1>
        <span className="ml-2 text-xs text-muted-foreground font-mono">
          {tab === "browse" ? "file browser" : "ai sessions"}
        </span>
      </header>

      {/* Main content */}
      <main className="flex-1 overflow-hidden">
        {tab === "browse" && <FileBrowser onLaunch={handleLaunch} />}
        {tab === "sessions" && <Sessions launchDir={launchDir} />}
      </main>

      {/* Bottom nav */}
      <nav className="border-t bg-card grid grid-cols-2 safe-pb">
        {NAV.map(({ id, label, icon: Icon }) => (
          <button
            key={id}
            onClick={() => setTab(id)}
            className={cn(
              "flex flex-col items-center justify-center gap-1 py-3 transition-colors",
              tab === id ? "text-primary" : "text-muted-foreground hover:text-foreground"
            )}
          >
            <Icon className="h-5 w-5" />
            <span className="text-xs font-medium">{label}</span>
          </button>
        ))}
      </nav>

      <Toaster />
    </div>
  );
}
