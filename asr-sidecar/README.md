# asr-sidecar

A small CPU-only proxy between LibreChat and a vLLM-served Qwen3-ASR model. It fixes
two things the upstream cannot do on its own:

| Problem | Cause | Fix here |
| --- | --- | --- |
| `HTTP 500` on browser dictation, `Format not recognised` in the vLLM log | Chrome on macOS/Android records Opus in **WebM**; the upstream's `soundfile` read only handles wav/ogg | ffmpeg transcode to 16 kHz mono wav before forwarding |
| Composer fills with `language English<asr_text>He wasn't even that big…` | vLLM's transcription handler returns the raw generation. `qwen_asr` applies `parse_asr_output` only in its inference layer, never on the server path | truncate through `<asr_text>` and return `{"text": "..."}` |

It holds no model, needs no GPU, and keeps no state.

## Files

```
asr-sidecar/
├── app.py                      # Flask app: auth, transcode, forward, strip prefix
├── requirements.txt
├── Dockerfile
└── compose.fragment.yml        # the service definition, pulled in by LibreChat via `include`
```

One entry point starts everything. The include goes in whichever override LibreChat
already uses — on this host `docker-compose.override.yaml`, appended below its existing
`api:` volumes block:

```yaml
include:
  - path: /home/main/vllm/Qwen3-ASR-1.7B/asr-sidecar/compose.fragment.yml
    project_directory: /home/main/vllm/Qwen3-ASR-1.7B/asr-sidecar
    env_file: /home/main/vllm/Qwen3-ASR-1.7B/.env
```

so `docker compose up -d` in `/opt/LibreChat` starts the app and the sidecar together. The
sidecar container is owned by the `librechat` project; the model project defines only
`qwen3-asr`. Defining the service in both projects produces a container-name conflict,
which is why the block was removed from the model project's override.

**Edit the override that already exists — do not create a second one.** Compose auto-loads
at most one, preferring `docker-compose.override.yml` over `.yaml`. A new `.yml` therefore
blinds compose to an existing `.yaml`, silently dropping everything declared only there —
a `librechat.yaml` bind mount included, which makes LibreChat fall back to no custom
config on the next `up`. Confirm with `docker compose config | grep librechat.yaml`, or
check `docker compose ls --format json` for the files actually in play.

## Contract

LibreChat's STT service posts `multipart/form-data` with `file` and `model`, then reads
`response.data.text` and treats anything else as a failure. So:

- `POST /v1/audio/transcriptions` accepts that body, plus optional `language`.
- Success is **HTTP 200 with a top-level `text` string**. `usage` is passed through but ignored.
- Silence yields `{"text": ""}` — `language None<asr_text>` maps to empty, matching
  `qwen_asr.inference.utils.parse_asr_output`.
- Failures return a non-200 with a generic message. Upstream error bodies are never
  relayed, because they can echo dictated audio and LibreChat surfaces provider text
  to the browser. Detail goes to the sidecar's log instead.
- `GET /healthz` reports status, upstream URL, and model name.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `UPSTREAM_URL` | `http://qwen3-asr:80/v1/audio/transcriptions` | vLLM endpoint. `compose.fragment.yml` overrides it with the host's published `http://<lan-ip>:8100/...` so the sidecar needs no network shared with the model container |
| `ASR_MODEL` | `qwen-asr` | model name when the request omits one |
| `UPSTREAM_API_KEY` | *(empty)* | bearer token for vLLM, if it was started with one |
| `SIDECAR_API_KEY` | *(empty)* | when set, requests must carry `Authorization: Bearer <key>` |
| `UPSTREAM_TIMEOUT_SECONDS` | `300` | vLLM request timeout |
| `FFMPEG_TIMEOUT_SECONDS` | `120` | decode timeout |
| `MAX_UPLOAD_BYTES` | `268435456` | request body cap, answered with 413 |
| `SAMPLE_RATE` | `16000` | output sample rate |
| `LOG_LEVEL` | `INFO` | Python log level |

Set `SIDECAR_API_KEY` and mirror it into `speech.stt.openai.apiKey` in
`librechat.yaml`. LibreChat already sends that header, so it costs nothing and stops
any LAN device from spending your GPU on transcriptions.

## Deploy

1. Copy the whole `asr-sidecar/` folder into the directory holding your `qwen3-asr`
   compose file. The folder itself, not its contents — the build context resolves from it.
2. Put the key in the `.env` that the `include` block names with `env_file` — on this
   host `/home/main/vllm/Qwen3-ASR-1.7B/.env`. Not `export`, which compose does not
   reliably see across `up` invocations. Leaving it unset stops the compose run outright,
   because `compose.fragment.yml` declares `SIDECAR_API_KEY` with the `:?`
   required-argument guard; an unset variable silently resolving to a placeholder is how a
   correct URL ends up returning 401 on every request.

   ```bash
   printf 'SIDECAR_API_KEY=%s\n' "$(openssl rand -hex 24)" > /home/main/vllm/Qwen3-ASR-1.7B/.env
   chmod 600 /home/main/vllm/Qwen3-ASR-1.7B/.env
   cd /opt/LibreChat && docker compose config | grep SIDECAR_API_KEY   # must show the value
   ```

3. Append the `include` block shown under [Files](#files) to whichever override
   `/opt/LibreChat` already uses. Check first: `ls /opt/LibreChat/docker-compose.override.*`
   — if a `.yaml` exists, use that rather than creating a `.yml`, which would shadow it.
4. `cd /opt/LibreChat && docker compose config --services` — must list `asr-sidecar`
   alongside the LibreChat services. Then `docker compose up -d`.
5. Update `librechat.yaml` (see below) and **restart** LibreChat. Editing the yaml alone
   changes nothing: the parsed config is cached, so a running process keeps serving the
   old URL. Without Redis that cache is process-local and `docker compose restart api`
   clears it; with `USE_REDIS=true` it has no TTL and survives a restart, so also run
   `docker exec LibreChat node config/flush-cache.js`. An invalid file is skipped in full
   rather than partially — check for `Invalid custom config` in the api log.

## Startup order

None is required. Neither side couples to the other at boot: the sidecar resolves
`UPSTREAM_URL` per request and the healthcheck only probes its own `/healthz`, while
LibreChat just stores the URL and calls it per transcription. A dictation that lands
while vLLM is still loading weights fails that one request with 502 and the next one
works. That is also why the compose block deliberately has no `depends_on`.

On boot everything comes up by itself — `docker.service` is enabled and each container is
`restart: unless-stopped` or `always`.

Because the sidecar is now part of the LibreChat project, `docker compose up -d` in
`/opt/LibreChat` starts it with everything else. The model project no longer defines it,
so running compose there cannot conflict over the container name — but that also means
`docker compose down` in the model directory no longer touches the sidecar.

```bash
cd /opt/LibreChat && docker compose up -d          # app + sidecar
docker compose -f /opt/LibreChat/docker-compose.yml restart asr-sidecar
```

## Runbook

Two compose projects are involved, and ownership determines which directory a command runs
from. They share no network: the sidecar reaches vLLM through the published port, so
`down` in either directory cannot break the other.

| Container | Project | Directory |
| --- | --- | --- |
| `LibreChat`, `asr-sidecar` | `librechat` | `/opt/LibreChat` |
| `qwen3-asr` | `qwen3-asr-17b` | `~/vllm/Qwen3-ASR-1.7B` |

| Want | Command |
| --- | --- |
| Start app + sidecar | `cd /opt/LibreChat && docker compose up -d` |
| Start the ASR model | `cd ~/vllm/Qwen3-ASR-1.7B && docker compose up -d` |
| Rebuild the sidecar after editing `app.py` | `cd /opt/LibreChat && docker compose up -d --build asr-sidecar` |
| Restart just the sidecar | `cd /opt/LibreChat && docker compose restart asr-sidecar` |
| Stop just the sidecar | `cd /opt/LibreChat && docker compose stop asr-sidecar` |
| Stop or stop+remove the ASR model | `cd ~/vllm/Qwen3-ASR-1.7B && docker compose stop qwen3-asr` / `... down` |
| Watch a transcription go through | `docker logs -f asr-sidecar` |
| Confirm which files compose is reading | `cd /opt/LibreChat && docker compose ls --format json` |

No ordering is required in normal operation, and reboot needs none either —
`docker.service` is enabled and the containers are `unless-stopped` / `always`. Stopping
one half leaves the other running; verified by a stop/start round trip that left
`qwen3-asr` untouched.

While the model is down, transcriptions fail with 502 `transcription backend unreachable`
in the sidecar log, and recover on their own once vLLM is listening again.

**If the server's LAN IP changes, update `UPSTREAM_URL` in `compose.fragment.yml`.** The
sidecar now reaches vLLM at `http://<host>:8100` rather than by compose service name, which
is what buys the independence between the two projects. A stale address fails loudly as the
502 above rather than silently.

After editing `librechat.yaml`, restarting the container is not enough on its own — see
step 5 of [Deploy](#deploy).

## LibreChat `librechat.yaml`

Only the `stt:` section concerns this sidecar. The example below shows `tts:` alongside it
**unchanged** — deploying the sidecar must not remove or edit it.

```yaml
speech:
  tts:                                   # unchanged by this sidecar
    allowedAddresses:
      - '192.168.1.1:8880'
    openai:
      url: 'http://192.168.1.1:8880/v1/audio/speech'
      apiKey: 'sk-no-key-required'
      model: 'kokoro'
      voices: ['af_heart', 'af_alloy']

  stt:                                   # the only section the sidecar changes
    allowedAddresses:
      - '192.168.1.1:8101'      # the sidecar, because that is the address LibreChat connects to
    openai:
      url: 'http://192.168.1.1:8101/v1/audio/transcriptions'
      apiKey: '<SIDECAR_API_KEY>'
      model: 'qwen-asr'
```

`allowedAddresses` entries are bare `host:port` pairs — no scheme, no path. The
sidecar→vLLM hop happens outside LibreChat's process and needs no entry.

## Verify

```bash
# webm proves the transcode path, ogg proves the pass-through path
curl -sS http://192.168.1.1:8101/v1/audio/transcriptions \
  -H 'Authorization: Bearer <SIDECAR_API_KEY>' \
  -F file=@/tmp/speech.webm -F model=qwen-asr

curl -sS http://192.168.1.1:8101/v1/audio/transcriptions \
  -H 'Authorization: Bearer <SIDECAR_API_KEY>' \
  -F file=@/tmp/speech.ogg -F model=qwen-asr
```

Both must print a transcript with no `language …<asr_text>` prefix. Then dictate from
the browser.

## Troubleshooting

| Symptom | Cause |
| --- | --- |
| 401 | `SIDECAR_API_KEY` does not match `speech.stt.openai.apiKey` |
| 400 `could not decode the uploaded audio` | ffmpeg could not open the upload; the sidecar log has ffmpeg's stderr |
| 502 `transcription backend unreachable` | vLLM is down, or `UPSTREAM_URL` names a stale host after a LAN IP change |
| 502 `... returned HTTP 500` | real upstream failure; read the vLLM container log |
| `[STT] Request failed` with no sidecar access-log line | SSRF block or wrong host:port — `allowedAddresses` must name the sidecar's published port |
| transcript still prefixed | vLLM emitted no `<asr_text>`; check the serve command's chat-template flags |
| empty composer after speaking | genuinely silent capture, or the model returned `language None<asr_text>` |
