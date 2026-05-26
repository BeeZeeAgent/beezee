import { useEffect, useState } from "react";
import { Download, ExternalLink, Loader2, RotateCw, X } from "lucide-react";
import { api, type UpdateInfo } from "@/api";
import { Button } from "@/components/ui/button";

function formatSize(bytes: number | null) {
  if (!bytes) return "";
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function UpdateBanner() {
  const [info, setInfo] = useState<UpdateInfo | null>(null);
  const [hidden, setHidden] = useState(false);
  const [updating, setUpdating] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    api.checkUpdate()
      .then(result => {
        if (cancelled || !result.updateAvailable || !result.latestVersion) return;
        if (localStorage.getItem(`beezee-update-dismissed-${result.latestVersion}`) === "1") return;
        setInfo(result);
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, []);

  if (!info || hidden) return null;

  const dismiss = () => {
    if (info.latestVersion) localStorage.setItem(`beezee-update-dismissed-${info.latestVersion}`, "1");
    setHidden(true);
  };

  const apply = async () => {
    setUpdating(true);
    setError(null);
    setMessage(null);
    try {
      const result = await api.applyUpdate();
      if (result.error) throw new Error(result.error);
      setMessage(result.message || "Update installed. Restart BeeZee to apply.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Update failed");
    } finally {
      setUpdating(false);
    }
  };

  return (
    <div className="border-b bg-zinc-950 px-3 py-2 text-white">
      <div className="flex min-w-0 items-center gap-2">
        <Download className="h-4 w-4 shrink-0 text-[#FFE566]" />
        <div className="min-w-0 flex-1">
          <p className="truncate text-xs font-medium">
            BeeZee {info.latestVersion} available
            {info.assetSize ? ` · ${formatSize(info.assetSize)}` : ""}
          </p>
          <p className="truncate text-[11px] text-zinc-300">
            {message || error || `Current version ${info.currentVersion}`}
          </p>
        </div>
        {info.canAutoUpdate ? (
          <Button
            size="sm"
            onClick={apply}
            disabled={updating || !!message}
            className="h-8 shrink-0 gap-1.5 bg-[#FFE566] px-2.5 text-xs text-black hover:bg-[#f5d94f]"
          >
            {updating ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RotateCw className="h-3.5 w-3.5" />}
            {message ? "Done" : "Update"}
          </Button>
        ) : info.releaseUrl ? (
          <a href={info.releaseUrl} target="_blank" rel="noopener noreferrer" className="shrink-0">
            <Button size="sm" className="h-8 gap-1.5 bg-[#FFE566] px-2.5 text-xs text-black hover:bg-[#f5d94f]">
              <ExternalLink className="h-3.5 w-3.5" />
              Open
            </Button>
          </a>
        ) : null}
        <Button
          variant="ghost"
          size="icon"
          onClick={dismiss}
          className="h-8 w-8 shrink-0 text-zinc-300 hover:bg-white/10 hover:text-white"
          title="Dismiss update"
        >
          <X className="h-4 w-4" />
        </Button>
      </div>
    </div>
  );
}
