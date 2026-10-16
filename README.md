# pi-ha

Use your LAN endpoint when it's reachable, otherwise Tailscale or another
fallback. Your usual model selection and display stay unchanged.

No extra service or background polling. Requires **Node 22.19+**; tested with
**Pi 1.2.0**. Supports `openai-completions` models in `models.json`.

## Install

```sh
pi install git:github.com/edwinbrowwn/pi-ha
```

Run `/reload` in Pi, or restart it.

## Usage

In `~/.pi/agent/models.json`, add an `ha` field to your existing model entry:

```json
{
  "id": "my-model",
  "ha": {
    "primaryLabel": "LAN",
    "fallbackUrls": [
      {
        "baseUrl": "http://server.remote.example:8000/v1",
        "label": "Remote",
        "timeoutMs": 1000
      }
    ]
  }
}
```

Keep your existing ID, metadata, URL and credentials; only add `ha`. The
provider's `baseUrl` is primary; fallbacks are tried in order. Replace the example
address with your remote or Tailscale URL. [Full example](models.example.json)
(all values are placeholders).

Run `/reload` after edits. Select your usual model with `/model`.

| Command | What it does |
| --- | --- |
| `/pi-ha` | Show cached status; no network requests |
| `/pi-ha check` | Recheck the selected HA model; no inference |
| `/pi-ha reset` | Clear its cache, or all caches if a non-HA model is selected |

### Options

| Field | Default | Purpose |
| --- | --- | --- |
| `probeTimeoutMs` | `100` | Primary health-check deadline, in ms |
| `fallbackTimeoutMs` | `1000` | Default fallback deadline, in ms |
| `cacheTtlMs` | `10000` | Cache healthy and unhealthy results; `0` disables caching |
| `healthPath` | `/v1/models` | Same-origin GET path; use `/health` if your server provides it |
| `primaryLabel` | `Primary` | Label shown by the status command |

`fallbackUrls` accepts strings or objects with `baseUrl` and optional `label`,
`timeoutMs`, `healthPath`. Remove `ha` or set it to `false` to disable HA.

A recovered primary is preferred after its cached failure expires. Probe
deadlines **do not limit inference**. Streams never switch mid-request; failover
uses Pi's normal transport retry. Auth, quota and request errors don't trigger it.

**Use only trusted addresses serving the same model:** all receive the same
credentials and prompts. Without pi-ha, Pi uses the primary URL.

## Update

```sh
pi update git:github.com/edwinbrowwn/pi-ha
```

Then run `/reload` or restart Pi.

## Uninstall

```sh
pi remove git:github.com/edwinbrowwn/pi-ha
```

Restart Pi or run `/reload`. You can also remove the `ha` field from your models;
your original provider and model settings stay in place.

For a local checkout, use `pi install .`, update with `git pull`, and uninstall
with `pi remove .`, all from the checkout directory.

## Tests

```sh
npm test
npm run test:unit
npm run test:integration
```

Unit tests need only Node. Integration tests also need `pi` on PATH (or
`PI_EXECUTABLE` pointing to it). They create temporary Pi settings and local mock
servers with dummy credentials—no accounts, real models or Tailscale required.
No runtime npm dependencies are installed by this package.

## License

MIT.
