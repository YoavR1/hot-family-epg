# Hosted playlist workflow

When the user asks to update the playlist, hosted playlist, channels, channel list, EPG, logos, or anything that should appear in the shared IPTV URL, treat this as a hosted update by default.

## Source of truth

Use this repo as the source of truth:

```text
C:\Users\Yoav\IPTV-Guide\repo
```

For channel-list changes, edit:

```text
C:\Users\Yoav\IPTV-Guide\repo\playlist.m3u8
```

Do not edit `C:\Users\Yoav\Desktop\playlist\playlist.m3u8` for hosted changes. That Desktop copy is local-only and no longer drives the hosted URL.

## Required steps

1. Edit `playlist.m3u8` in the repo.
2. Preserve the file exactly except for the intended change: line endings, separators, logos, groups, EPG attributes, ordering, and all other channel lines.
3. Commit the change.
4. Push to `origin/main`.

That push triggers `.github/workflows/playlist-sync.yml`, which immediately refreshes the Cloudflare Worker. No manual refresh is needed.

## Do not do for normal playlist updates

- Do not run `UPDATE_PLAYLIST.bat`; it has been removed.
- Do not edit `cf-worker/src/worker.js` for playlist content changes.
- Do not run `npx wrangler deploy` for playlist content changes.
- Do not regenerate `playlist_data.js` for playlist content changes.
- Do not modify `refresh.ps1` unless the user explicitly asks.

## Main hosted URL

```text
https://hls-healer.rivkinyoav.workers.dev/playlist.m3u
```

If the user says “local only” or “Desktop playlist only,” do not commit or push. Otherwise, default to the hosted workflow above.
