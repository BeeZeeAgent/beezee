import { useState, useEffect, useCallback } from "react";
import { ChevronRight, FolderOpen, File, Home, ArrowLeft, Rocket, Search, X } from "lucide-react";
import { api, type BrowseItem } from "@/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import { cn } from "@/lib/utils";

interface FileBrowserProps {
  onLaunch: (dir: string) => void;
}

const HOME = "/home/pi";

export function FileBrowser({ onLaunch }: FileBrowserProps) {
  const [currentPath, setCurrentPath] = useState(HOME);
  const [parent, setParent] = useState("/home");
  const [items, setItems] = useState<BrowseItem[]>([]);
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const navigate = useCallback(async (path: string) => {
    setLoading(true);
    setError(null);
    try {
      const result = await api.browse(path);
      setCurrentPath(result.path);
      setParent(result.parent);
      setItems(result.items);
      setQuery("");
    } catch {
      setError("Cannot read directory");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { navigate(HOME); }, [navigate]);

  const pathParts = currentPath.split("/").filter(Boolean);
  const normalizedQuery = query.trim().toLowerCase();
  const filteredItems = normalizedQuery
    ? items.filter(item => item.isDir && item.name.toLowerCase().includes(normalizedQuery))
    : items;
  const visibleFolderCount = filteredItems.filter(item => item.isDir).length;

  return (
    <div className="flex flex-col h-full">
      {/* Breadcrumb */}
      <div className="flex items-center gap-1 px-4 py-3 border-b overflow-x-auto">
        <Button variant="ghost" size="icon" className="shrink-0 h-7 w-7" onClick={() => navigate(HOME)}>
          <Home className="h-3.5 w-3.5" />
        </Button>
        {pathParts.map((part, i) => {
          const fullPath = "/" + pathParts.slice(0, i + 1).join("/");
          const isLast = i === pathParts.length - 1;
          return (
            <div key={fullPath} className="flex items-center gap-1 shrink-0">
              <ChevronRight className="h-3 w-3 text-muted-foreground" />
              <button
                onClick={() => !isLast && navigate(fullPath)}
                className={cn(
                  "text-xs px-1 py-0.5 rounded",
                  isLast
                    ? "text-foreground font-medium"
                    : "text-muted-foreground hover:text-foreground hover:bg-accent"
                )}
              >
                {part}
              </button>
            </div>
          );
        })}
      </div>

      {/* Launch button for current directory */}
      <div className="px-4 py-2 bg-muted/30 border-b flex items-center justify-between gap-3">
        <p className="text-xs text-muted-foreground truncate min-w-0">{currentPath}</p>
        <Button size="sm" className="shrink-0 gap-1.5" onClick={() => onLaunch(currentPath)}>
          <Rocket className="h-3.5 w-3.5" />
          Launch here
        </Button>
      </div>

      <div className="px-4 py-2 border-b bg-background">
        <div className="relative">
          <Search className="absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={query}
            onChange={e => setQuery(e.target.value)}
            placeholder="Search folders"
            className="h-9 pl-8 pr-8"
          />
          {query && (
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="absolute right-1 top-1/2 h-7 w-7 -translate-y-1/2"
              onClick={() => setQuery("")}
              aria-label="Clear search"
            >
              <X className="h-3.5 w-3.5" />
            </Button>
          )}
        </div>
      </div>

      {/* File list */}
      <ScrollArea className="flex-1">
        {loading && (
          <div className="flex items-center justify-center h-24 text-sm text-muted-foreground">
            Loading…
          </div>
        )}
        {error && (
          <div className="flex items-center justify-center h-24 text-sm text-destructive">
            {error}
          </div>
        )}
        {!loading && !error && (
          <div className="py-1">
            {currentPath !== "/" && (
              <>
                <button
                  onClick={() => navigate(parent)}
                  className="w-full flex items-center gap-3 px-4 py-2.5 hover:bg-accent text-muted-foreground hover:text-foreground transition-colors"
                >
                  <ArrowLeft className="h-4 w-4 shrink-0" />
                  <span className="text-sm">..</span>
                </button>
                <Separator />
              </>
            )}
            {items.length === 0 && (
              <p className="text-center text-sm text-muted-foreground py-8">Empty directory</p>
            )}
            {items.length > 0 && filteredItems.length === 0 && (
              <p className="text-center text-sm text-muted-foreground py-8">No folders match "{query}"</p>
            )}
            {normalizedQuery && filteredItems.length > 0 && (
              <p className="px-4 py-2 text-xs text-muted-foreground">
                {visibleFolderCount} folder{visibleFolderCount === 1 ? "" : "s"} found
              </p>
            )}
            {filteredItems.map((item) => (
              <button
                key={item.path}
                onClick={() => item.isDir && navigate(item.path)}
                className={cn(
                  "w-full flex items-center gap-3 px-4 py-2.5 transition-colors",
                  item.isDir
                    ? "hover:bg-accent cursor-pointer"
                    : "cursor-default opacity-60"
                )}
              >
                {item.isDir ? (
                  <FolderOpen className="h-4 w-4 shrink-0 text-amber-500" />
                ) : (
                  <File className="h-4 w-4 shrink-0 text-muted-foreground" />
                )}
                <span className="text-sm truncate text-left">{item.name}</span>
                {item.isDir && <ChevronRight className="h-3.5 w-3.5 ml-auto shrink-0 text-muted-foreground" />}
              </button>
            ))}
          </div>
        )}
      </ScrollArea>
    </div>
  );
}
