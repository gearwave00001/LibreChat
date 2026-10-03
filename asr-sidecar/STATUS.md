# Status — RESOLVED, confirmed from the browser

Dictation transcribes correctly in the browser, completing the chain: browser → LibreChat
→ sidecar (ffmpeg transcode, prefix strip) → vLLM. Read-aloud works over plain HTTP with
*Cache Text to Speech* off. No startup ordering is needed, and one
`docker compose up -d` in `/opt/LibreChat` starts the app and the sidecar together.

Three separate faults had stacked up behind that one button, which is why it took so long:

1. `caches` is undefined on insecure origins, and `cacheTTS` defaults true — read-aloud
   threw before issuing any request, so nothing reached the backend and no log appeared.
2. vLLM's server path never calls `parse_asr_output` and cannot decode Opus-in-WebM — the
   two defects the sidecar exists to fix.
3. The running LibreChat had not reloaded `librechat.yaml`, and `SIDECAR_API_KEY` had
   silently resolved to the `changeme` default.

Plus one regression I introduced and fixed: creating a `docker-compose.override.yml`
shadowed the deployment's existing `.yaml`, because compose auto-loads at most one
override and prefers `.yml`. See *Follow-up 2*.

Diagnosed and fixed directly against the server with docker access. The bug had two
layers, and fixing only the first would have turned the 500 into a 401.

## Root cause (proven, not inferred)

1. **LibreChat never reloaded `librechat.yaml`.** The api container started
   `2026-10-03T10:16:35Z`; `/opt/LibreChat/librechat.yaml` was last modified
   `12:21:39Z` — two hours later. Its own startup banner still printed
   `"url": "http://192.168.1.1:8100/v1/audio/transcriptions"`. `USE_REDIS` is unset in
   the container, so `ensureBaseConfig` reads the base config from a **process-local**
   cache (`packages/api/src/app/service.ts:370`, `api/cache/getLogStores.js:52`) — the
   edit was live on disk but invisible to the running process. This is why vLLM logged
   the 500 from `172.23.0.1` while the sidecar logged nothing: the request genuinely
   bypassed the sidecar, straight to `:8100`.
2. **A key mismatch sat behind it.** `SIDECAR_API_KEY` was still the compose default
   `changeme` — the project directory had no `.env`, so `${SIDECAR_API_KEY:-changeme}`
   never resolved — while `librechat.yaml` sends `1f5ebd2d…`. The moment the URL started
   working, every request would have been rejected 401.

## Follow-up 2: override-file shadowing (a regression I introduced, now fixed)

LibreChat's deployment uses `docker-compose.override.yaml` — the `.yaml` spelling — to
bind-mount `librechat.yaml` into the api container. I searched for `docker-compose.override.yml`,
found none, and created one. Compose auto-loads at most one override and prefers `.yml`
over `.yaml`, so compose stopped reading the existing file entirely.

Measured, not assumed:

| Config source | `librechat.yaml` mount | `asr-sidecar` |
| --- | --- | --- |
| explicit `-f docker-compose.yml -f docker-compose.override.yaml` | present | present |
| auto-load while my `.yml` existed | **absent** | present |

The running container kept its mount, so nothing broke immediately, but the next
`docker compose up -d api` would have recreated it with no custom config — silently
disabling STT and TTS. Fixed by appending the `include` to the existing `.yaml` and
removing my `.yml`. After the fix, auto-load resolves the mount again and
`docker compose up -d --dry-run` reports every container `Running`, i.e. the corrected
config is a no-op against live state.

Lesson: check `ls docker-compose.override.*` before creating one.

## Follow-up: one entry point

The sidecar used to live in a separate compose project, so `docker compose up -d` in
`/opt/LibreChat` did not start it. It now belongs to the `librechat` project:

- `/opt/LibreChat/docker-compose.override.yml` gained an `include` pointing at
  [`compose.fragment.yml`](compose.fragment.yml), with `env_file` naming
  `/home/main/vllm/Qwen3-ASR-1.7B/.env`.
- The `asr-sidecar:` block was removed from
  `/home/main/vllm/Qwen3-ASR-1.7B/docker-compose.override.yml` — original preserved as
  `docker-compose.override.yml.bak.*`. Defining it in both projects is a container-name
  conflict, and adopting `qwen3-asr` into the LibreChat project would let `up` recreate the
  vLLM container and reload its weights for nothing.
- The fragment initially joined `qwen3-asr-17b_default` as an **external** network so
  `qwen3-asr` resolved by service name. That coupling was later removed — see *Follow-up 3*.
- `SIDECAR_API_KEY` now uses the `:?` guard instead of a `changeme` default, confirmed to
  abort `docker compose config` with exit 1 rather than silently starting an
  unreachable-key sidecar.

## Fixes applied on the server

- `scp` of the current [`app.py`](app.py) to
  `/home/main/vllm/Qwen3-ASR-1.7B/asr-sidecar/app.py` (deployed copy was identical
  except the per-request log line).
- Created `/home/main/vllm/Qwen3-ASR-1.7B/.env` mode `600` with
  `SIDECAR_API_KEY=<the yaml apiKey>`, then `docker compose up -d --build asr-sidecar`.
- `cd /opt/LibreChat && docker compose restart api` — sufficient because there is no
  Redis; with `USE_REDIS=true` a `flush-cache` would also have been required.

Nothing was deleted.

## Verification

| Check | Result |
| --- | --- |
| Startup banner after restart | `"url": "http://192.168.1.1:8101/v1/audio/transcriptions"`, zero `Invalid custom config` |
| `GET /healthz` from inside the api container | `200 {"model":"qwen-asr","upstream":"http://qwen3-asr:80/..."}` |
| webm + wav through the sidecar | `200` both, transcript clean — no `language …<asr_text>` |
| Same wav direct to `:8100` | `language English<asr_text>The quick brown fox…` — confirms the sidecar is what strips it |
| New key | `200`; old `changeme` | `401` |
| Kokoro TTS from inside the api container | `200`, 14636 bytes `audio/mpeg` |
| Sidecar per-request log | `transcribe from 172.23.0.1: s.webm (12318 bytes, model=qwen-asr) -> …` |

Topology note: LibreChat reaches the sidecar over the published `:8101`, which is why
`allowedAddresses` names `192.168.1.1:8101`; the sidecar reaches vLLM over the published
`:8100`. Neither hop is container-to-container, so no network is shared between the two
compose projects.

## Follow-up 3: removed the cross-project network coupling

The external-network attachment made the two projects interdependent in a way that was easy
to trip. `docker compose down` removes networks, and a network declared `external: true` is
never recreated, so tearing down the model project made `up` in `/opt/LibreChat` fail with
`network qwen3-asr-17b_default declared as external, but could not be found` — verified
against a synthetic compose file. Compose masked it too: while the sidecar was still
attached, `down` reported `Resource is still in use` rather than warning about the
consequence.

Both paths were confirmed to work before switching (`http://192.168.1.1:8100/health` and
`http://qwen3-asr:80/health` each returned 200 from inside the container), so the choice was
ours. Trade-off accepted: the fragment now hard-codes the host LAN IP in `UPSTREAM_URL`, so
changing that address requires an edit. The failure mode is a loud 502
`transcription backend unreachable` in the sidecar log, never a silent one.

After the switch: the sidecar attaches only to `librechat_default`, the model network is
attached only by `qwen3-asr`, LibreChat's resolved config contains zero references to
`qwen3-asr-17b_default`, and a webm transcription still returns a clean transcript.

---

# Original handoff notes

Written so the next round of diagnosis happens against real docker access
instead of pasted log excerpts.

Where the Qwen3-ASR + LibreChat STT/TTS setup stands after the debugging session on the
workstation. Written so the next round of diagnosis happens against real docker access
instead of pasted log excerpts.

## Proven (evidence-backed, no assumptions)

| Fact | Evidence |
| --- | --- |
| `caches` (Cache Storage) is undefined on insecure origins → read-aloud threw `ReferenceError: caches is not defined` before any request | browser stack at `toggleSpeech`; `cacheTTS` defaults **true** (`client/src/store/settings.ts:147`) |
| TTS needs **no** HTTPS — only `caches` and the mic do. Disabling *Cache Text to Speech* makes external TTS work over plain HTTP | `client/src/hooks/Input/useTextToSpeechExternal.ts:108-113,150` |
| *Automatic Playback* must stay off too: `client/src/components/Chat/Input/StreamAudio.tsx:70` calls `caches.open()` unconditionally | code read |
| localStorage beats `speechTab` yaml defaults | `client/src/hooks/Config/useSpeechSettingsInit.ts:64` |
| `speech.{tts,stt}.openai.url` is used **verbatim**, no path appended | `api/server/services/Files/Audio/STTService.js:211`, `TTSService.js:113` |
| `allowedAddresses` entries are bare `host:port` — scheme/path ⇒ ZodError ⇒ **entire** yaml ignored | `packages/data-provider/src/config.ts:242-271`, observed error |
| Correct serve command: `qwen-asr-serve /app/models --served-model-name qwen-asr --gpu-memory-utilization 0.95 --host 0.0.0.0 --port 80` — model positional, no subcommand | `serve --help` ⇒ vllm serve; HF model card |
| vLLM direct: wav → 200, ogg → 200, webm → **500 `Format not recognised`** (soundfile cannot decode Opus-in-WebM) | curl matrix |
| vLLM returns raw `language <Lang><asr_text>…`; `parse_asr_output` never runs on the server path; `language=en` is ignored | grep of `qwen_asr` package + curl |
| LibreChat stores whatever `response.data.text` contains, verbatim | `STTService.js:334` |
| The container log can never reveal the STT cause: `getSafeErrorMetadata` strips messages/bodies by design | `packages/api/src/utils/errors.ts:18-40` |

The sidecar exists to fix exactly two upstream defects: ffmpeg transcode of every
browser container to 16 kHz mono wav, and `strip_prefix` of the `language …<asr_text>`
prefix. Both verified locally (5 strip cases; real-ffmpeg transcode of webm/ogg/garbage).

## Unresolved — the open bug

STT still returns 500. Last evidence:

- `asr-sidecar` logs **only** its own `GET /healthz 200` — no `POST /v1/audio/transcriptions`
- vLLM logs `POST /v1/audio/transcriptions 500` from `172.23.0.1` (bridge gateway ⇒
  traffic arriving via a *published port*, not container-to-container)
- `librechat.yaml` **already** points at `http://192.168.1.1:8101/v1/audio/transcriptions`

So the 500'd request reaches vLLM without passing through the sidecar, even though the
yaml on disk says 8101. My earlier "you still have 8100" claim was wrong — the yaml was
already updated. The explanation below is a hypothesis, not an observation.

## Leading hypothesis: the running process never reloaded the yaml

`ensureBaseConfig` reads the base config from the `APP_CONFIG` cache under key `_BASE_`
(`packages/api/src/app/service.ts:370-377`), and that cache is built with
`standardCache(CacheKeys.APP_CONFIG)` — **no TTL** (`api/cache/getLogStores.js:52`).
Consequences:

- `USE_REDIS=true` ⇒ the parsed yaml lives in Redis **indefinitely**, surviving
  `docker compose restart api`. Editing `librechat.yaml` changes nothing until the
  cache is flushed. This fits every observation: old `:8100` URL still in effect,
  vLLM 500 from the bridge gateway, sidecar silent.
- No Redis ⇒ the cache is process-local memory and a restart is enough; then this
  hypothesis is dead and the checks below decide.

## Checks to run on the server (in order)

```bash
# 1. sidecar actually registered and published?
docker compose ps
docker compose config --services          # must list asr-sidecar

# 2. sidecar env: key must equal speech.stt.openai.apiKey; check UPSTREAM_URL host is reachable
docker exec asr-sidecar printenv UPSTREAM_URL SIDECAR_API_KEY

# 3. rebuild to pick up the per-request log line added at app.py:144, then dictate once
docker compose up -d --build asr-sidecar
docker logs --since 5m asr-sidecar 2>&1 | grep -v healthz

# 4. is the yaml even in effect? invalid file => skipped in full
docker logs --since 30m LibreChat 2>&1 | grep -iE 'invalid custom config|Custom config file loaded'
docker exec LibreChat printenv USE_REDIS CONFIG_PATH
docker inspect LibreChat --format '{{json .Mounts}}'   # confirm the mounted librechat.yaml

# 5. if USE_REDIS=true, force a config reload (restart alone is NOT enough)
docker exec LibreChat node config/flush-cache.js   # or restart the redis container

# 6. sidecar direct, bypassing LibreChat entirely (webm = transcode path, ogg = passthrough)
curl -sS http://192.168.1.1:8101/v1/audio/transcriptions \
  -H 'Authorization: Bearer <SIDECAR_API_KEY>' -F file=@/tmp/speech.webm -F model=qwen-asr
```

Decision rule: if step 3 shows no sidecar `transcribe from …` line while vLLM logs the
500, the running LibreChat still holds the old URL — flush per step 5. If the sidecar
*does* log the request and still forwards something vLLM rejects, read its
`decode failed` / `upstream returned HTTP` lines.

## Resolved since these notes were written

Each item below was open when this section was drafted and is now closed.

- **TTS against Kokoro `:8880/v1/audio/speech`** — verified `200 audio/mpeg`, both directly
  and from inside the api container; `tts` and `stt` both appear in the loaded config.
- **`SIDECAR_API_KEY` vs the yaml `apiKey`** — they differed. The container still had the
  `changeme` default because no `.env` existed. Now aligned and guarded by `:?`.
- **Shared compose network** — established, then deliberately removed; see *Follow-up 3*.
- **Browser dictation** — confirmed working by the user.
- **`cacheTTS`** — stays off; the earlier `caches` ReferenceError is gone.

## Granting docker access from the workstation

Verified from this machine: `ssh main@192.168.1.1` already works passwordless
(`id -nG` ⇒ `main adm cdrom sudo dip plugdev lxd kvm`). The only blocker is group
membership — `/var/run/docker.sock` is `root:docker` mode `0660` and the `docker` group
has **no members** (`docker:x:987:`). `sudo -n` needs a password; `setfacl` and `at` are
not installed.

Grant, on the server (no daemon restart, so no container is disrupted; sshd recomputes
groups per login, so it applies to the next command without a logout):

```bash
sudo usermod -aG docker main        # revoke: sudo gpasswd -d main docker
```

`docker` group membership is root-equivalent — a member can bind-mount any host path into
a container. On a single-admin LAN box that is the usual tradeoff, but revoke when done.

Fallback without touching group membership: `sudo chmod 666 /var/run/docker.sock`
(revert `660`). Self-reverting on the next `docker.service` restart, but readable by every
local user and container meanwhile.

## Files in this folder

- `app.py` — the proxy; per-request log line at :144 makes a bypass directly observable
- `Dockerfile`, `requirements.txt` — python:3.12-slim + ffmpeg + gunicorn
- `docker-compose.override.yml` — **copy beside the model host's `docker-compose.yml`**;
  only that exact filename is auto-loaded, which is why earlier names stayed invisible
- `README.md` — contract, env vars, deploy steps, troubleshooting table
