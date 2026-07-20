export type AppUpdateCheck =
  | { status: "unsupported" }
  | { status: "current" }
  | { status: "available"; version: string; notes?: string }
  | { status: "error"; message: string };

export type AppUpdateInstall = { ok: true } | { ok: false; message: string };

type PendingUpdate = Awaited<
  ReturnType<typeof import("@tauri-apps/plugin-updater")["check"]>
>;

let pendingUpdate: PendingUpdate;

function isTauriRuntime(): boolean {
  const runtime = globalThis as {
    __TAURI_INTERNALS__?: unknown;
    isTauri?: boolean;
  };
  return Boolean(runtime.isTauri || runtime.__TAURI_INTERNALS__);
}

export async function checkForAppUpdate(): Promise<AppUpdateCheck> {
  if (!isTauriRuntime()) {
    return { status: "unsupported" };
  }
  try {
    if (pendingUpdate) {
      await pendingUpdate.close();
      pendingUpdate = null;
    }
    const { check } = await import("@tauri-apps/plugin-updater");
    pendingUpdate = await check({ timeout: 30_000 });
    if (!pendingUpdate) {
      return { status: "current" };
    }
    return {
      status: "available",
      version: pendingUpdate.version,
      ...(pendingUpdate.body ? { notes: pendingUpdate.body } : {}),
    };
  } catch (error) {
    return {
      status: "error",
      message: error instanceof Error ? error.message : "Update check failed",
    };
  }
}

export async function installAppUpdate(
  onProgress?: (downloaded: number, total?: number) => void,
): Promise<AppUpdateInstall> {
  if (!pendingUpdate) {
    return { ok: false, message: "Check for an update first" };
  }
  let downloaded = 0;
  let total: number | undefined;
  try {
    await pendingUpdate.downloadAndInstall((event) => {
      if (event.event === "Started") {
        total = event.data.contentLength;
        onProgress?.(downloaded, total);
      } else if (event.event === "Progress") {
        downloaded += event.data.chunkLength;
        onProgress?.(downloaded, total);
      }
    });
    const { relaunch } = await import("@tauri-apps/plugin-process");
    await relaunch();
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      message:
        error instanceof Error ? error.message : "Update installation failed",
    };
  }
}
