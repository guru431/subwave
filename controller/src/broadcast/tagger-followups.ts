// Completion policy for library-maintenance children. The ID journal must be
// settled before any consumer rebuilds from the migrated library. Successful
// catalogue walks then refresh auto.m3u immediately so Liquidsoap cannot keep
// coasting on pre-migration IDs until the hourly scheduler tick.

export type MaintenanceMode = 'tag' | 'analyze' | 'reconcile';
export type MaintenanceOutcome = 'ok' | 'failed' | 'stopped';

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export async function runTaggerFollowups(opts: {
  mode: MaintenanceMode;
  outcome: MaintenanceOutcome;
  rotationSettled: boolean;
  syncPlaylists: () => Promise<void>;
  refreshAutoPlaylist: () => Promise<unknown>;
  logError: (message: string) => void;
}): Promise<void> {
  if (!opts.rotationSettled || opts.outcome !== 'ok') return;

  // The normal admin analyzer does not walk an already-populated catalogue, so
  // it cannot discover or adopt rotated IDs. Tag and reconcile both do. Rebuild
  // the on-air fallback before recipe maintenance: a large recipe set must not
  // prolong starvation after the catalogue itself is already repaired.
  if (opts.mode !== 'analyze') {
    try {
      await opts.refreshAutoPlaylist();
    } catch (err: unknown) {
      opts.logError(`post-${opts.mode} auto-playlist refresh failed: ${errorMessage(err)}`);
    }
  }

  try {
    await opts.syncPlaylists();
  } catch (err: unknown) {
    opts.logError(`post-maintenance playlist sync failed: ${errorMessage(err)}`);
  }
}
