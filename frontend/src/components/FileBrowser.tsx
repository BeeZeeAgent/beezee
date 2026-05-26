import { useState, useEffect, useCallback, useRef } from "react";
import { ChevronRight, FolderOpen, File, Home, ArrowLeft, Rocket, Search, X, Upload, Files, FolderInput, Loader2 } from "lucide-react";
import { api, type BrowseItem } from "@/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import { cn } from "@/lib/utils";

interface FileBrowserProps {
  onLaunch: (dir: string) => void;
}

export function FileBrowser({ onLaunch }: FileBrowserProps) {
  const [home, setHome] = useState("");
  const [currentPath, setCurrentPath] = useState("");
  const [parent, setParent] = useState("");
  const [items, setItems] = useState<BrowseItem[]>([]);
  const [query, setQuery] = useState("");
  const [searchResults, setSearchResults] = useState<{ path: string; name: string }[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [uploadDropdown, setUploadDropdown] = useState<string | null>(null);
  const [uploadTarget, setUploadTarget] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);

  const filesRef = useRef<HTMLInputElement>(null);
  const folderRef = useCallback((el: HTMLInputElement | null) => {
    if (el) el.setAttribute("webkitdirectory", "");
  }, []);
  const folderInputRef = useRef<HTMLInputElement>(null);

  const navigate = useCallback(async (path: string) => {
    setLoading(true);
    setError(null);
    setUploadDropdown(null);
    setSearchResults(null);
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

  useEffect(() => {
    api.getHome().then(({ home: h }) => {
      setHome(h);
      navigate(h);
    }).catch(() => navigate("/"));
  }, [navigate]);

  useEffect(() => {
    if (query.length < 2) { setSearchResults(null); return; }
    setSearching(true);
    const timer = setTimeout(() => {
      api.searchDirs(query)
        .then(({ results }) => setSearchResults(results))
        .catch(() => setSearchResults([]))
        .finally(() => setSearching(false));
    }, 300);
    return () => clearTimeout(timer);
  }, [query]);

  const handleUpload = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || []);
    if (!files.length || !uploadTarget) return;
    setUploading(true);
    try {
      const relativePaths = files.map(f => (f as File & { webkitRelativePath?: string }).webkitRelativePath || f.name);
      await api.upload(uploadTarget, files, relativePaths);
      if (uploadTarget === currentPath) navigate(currentPath);
    } finally {
      setUploading(false);
      e.target.value = "";
    }
  }, [uploadTarget, currentPath, navigate]);

  const openUpload = (dest: string, type: "files" | "folder") => {
    setUploadTarget(dest);
    setUploadDropdown(null);
    if (type === "files") filesRef.current?.click();
    else folderInputRef.current?.click();
  };

  const pathParts = currentPath.split("/").filter(Boolean);
  const isDeepSearch = query.length >= 2;

  return (
    <div className="flex flex-col h-full">
      {/* Hidden file inputs */}
      <input ref={filesRef} type="file" multiple hidden onChange={handleUpload} />
      <input ref={(el) => { (folderInputRef as React.MutableRefObject<HTMLInputElement | null>).current = el; folderRef(el); }} type="file" multiple hidden onChange={handleUpload} />

      {/* Breadcrumb */}
      <div className="flex items-center gap-1 px-4 py-3 border-b overflow-x-auto">
        <Button variant="ghost" size="icon" className="shrink-0 h-7 w-7" onClick={() => navigate(home)}>
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

      {/* Dropdown backdrop */}
      {uploadDropdown && (
        <div className="fixed inset-0 z-10" onClick={() => setUploadDropdown(null)} />
      )}

      {/* File list */}
      <ScrollArea className="flex-1">
        {/* Deep search results */}
        {isDeepSearch && (
          <div className="py-1">
            {searching && (
              <div className="flex items-center gap-2 px-4 py-3 text-xs text-muted-foreground">
                <Loader2 className="h-3 w-3 animate-spin" />
                Searching…
              </div>
            )}
            {!searching && searchResults !== null && searchResults.length === 0 && (
              <p className="text-center text-sm text-muted-foreground py-8">No folders match "{query}"</p>
            )}
            {!searching && searchResults && searchResults.length > 0 && (
              <>
                <p className="px-4 py-2 text-xs text-muted-foreground">{searchResults.length} folder{searchResults.length !== 1 ? "s" : ""} found</p>
                {searchResults.map(result => (
                  <div key={result.path} className="flex items-center gap-3 px-4 py-2.5 hover:bg-accent transition-colors">
                    <FolderOpen className="h-4 w-4 shrink-0 text-amber-500" />
                    <div className="flex-1 min-w-0 cursor-pointer" onClick={() => navigate(result.path)}>
                      <p className="text-sm truncate">{result.name}</p>
                      <p className="text-xs text-muted-foreground truncate">{result.path}</p>
                    </div>
                    <div className="flex shrink-0 items-center gap-0.5">
                      <Button size="sm" className="h-7 px-2.5 text-xs shrink-0" style={{ background: "#FFE566", color: "#000", border: "none" }} onClick={() => onLaunch(result.path)}>
                        <Rocket className="h-3 w-3 mr-1" />Launch
                      </Button>
                      <Button variant="ghost" size="icon" className="h-7 w-7 shrink-0" title="Open folder" onClick={() => navigate(result.path)}>
                        <ChevronRight className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                  </div>
                ))}
              </>
            )}
          </div>
        )}

        {/* Regular directory listing */}
        {!isDeepSearch && loading && (
          <div className="flex items-center justify-center h-24 text-sm text-muted-foreground">
            Loading…
          </div>
        )}
        {!isDeepSearch && error && (
          <div className="flex items-center justify-center h-24 text-sm text-destructive">
            {error}
          </div>
        )}
        {!isDeepSearch && !loading && !error && (
          <div className="py-1">
            {currentPath && currentPath !== "/" && (
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
            {items.map((item) => (
              <div
                key={item.path}
                className={cn(
                  "flex items-center gap-3 px-4 py-2.5 transition-colors",
                  item.isDir ? "hover:bg-accent" : "opacity-60"
                )}
              >
                {item.isDir ? (
                  <FolderOpen className="h-4 w-4 shrink-0 text-amber-500" />
                ) : (
                  <File className="h-4 w-4 shrink-0 text-muted-foreground" />
                )}
                <span
                  className={cn("text-sm truncate text-left flex-1 min-w-0", item.isDir && "cursor-pointer")}
                  onClick={() => item.isDir && navigate(item.path)}
                >
                  {item.name}
                </span>

                {item.isDir && (
                  <div className="flex items-center gap-0.5 shrink-0 relative">
                    {/* Upload dropdown */}
                    <div className="relative">
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-7 w-7"
                        title="Upload to this folder"
                        disabled={uploading}
                        onClick={(e) => { e.stopPropagation(); setUploadDropdown(uploadDropdown === item.path ? null : item.path); }}
                      >
                        <Upload className="h-3.5 w-3.5" />
                      </Button>
                      {uploadDropdown === item.path && (
                        <div className="absolute right-0 top-full mt-1 z-20 bg-popover border rounded-md shadow-md py-1 min-w-[148px]">
                          <button
                            className="w-full flex items-center gap-2 px-3 py-1.5 text-sm hover:bg-accent text-left"
                            onClick={() => openUpload(item.path, "files")}
                          >
                            <Files className="h-3.5 w-3.5 text-muted-foreground" />
                            Upload files
                          </button>
                          <button
                            className="w-full flex items-center gap-2 px-3 py-1.5 text-sm hover:bg-accent text-left"
                            onClick={() => openUpload(item.path, "folder")}
                          >
                            <FolderInput className="h-3.5 w-3.5 text-muted-foreground" />
                            Upload folder
                          </button>
                        </div>
                      )}
                    </div>

                    {/* Navigate button */}
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-7 w-7"
                      title="Open folder"
                      onClick={() => navigate(item.path)}
                    >
                      <ChevronRight className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </ScrollArea>
    </div>
  );
}
