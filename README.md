# The Crypt

Threat simulation - a website to replicate a threat actor using hidden services

<h1 align="center">
<br>
<img src=assets/onion-graveyard.png>
<br>
The Crypt
</h1>


## Liability

Think before you type, I am not responsible for the misuse of this tool.
This project is specifically for threat emulation and helping Red/Blue/Purple Teams with their objectives.
If you found this tool useful, pay it forward and help the next person out.

## Description

This repo helps build and deploy a Tor hidden service to Kubernetes. A demo
"threat actor" website is included, free to modify for your engagements.

The site is served by an **unprivileged nginx** container. Tor runs as a
**separate sidecar** in the same Pod and publishes the hidden service, reaching
nginx over the Pod's loopback. nginx never binds a routable interface, so there
is no clearnet surface — **Tor is the only ingress**.

The page itself is built for anonymity: no external fonts, scripts, images or
analytics (everything is served from the onion), a `no-referrer` policy and a
strict `default-src 'self'` Content-Security-Policy, so a visitor's browser
cannot be made to leak to a third party.

## Layout

```
website/                      static site (HTML/CSS/JS, favicon)
website/biopsy-N/             generated case files (one per Death Row tile)
tools/generate_biopsies.py    generates the biopsy pages, tiles and leak archive
website/chat/                 customer chat page (register with key / sign in)
website/admin/                operator console (inbox, replies, access keys)
chat-api/                     chat backend (Node + Express + Mongoose)
Dockerfile                    production website image (unprivileged nginx)
Dockerfile.dev                local dev image (live-editable)
docker-compose.yml            local dev stack
nginx-prod.conf / nginx-dev.conf / nginx-hardening.conf
container-images/tor-sidecar.dockerfile   keyless Tor image
kubernetes/deployment-sidecar.yaml        the deployment (nginx + chat-api + tor)
kubernetes/mongodb.yaml                   MongoDB on NFS for accounts + chat logs
kubernetes/scripts/                       deploy / reroll / secrets scripts
kubernetes/config.example.env             settings for the scripts (copy to config.env)
build_all.sh                  builds (and optionally pushes) the three images
```

## Local development

See the site locally with live editing — no Tor, served on
`http://localhost:8080`:

```
docker compose up --build        # or: docker compose up -d --build
docker compose down
```

Edit anything under `website/` (HTML, `css/custom-styles.css`,
`js/*.js`) and just refresh — the source tree is bind-mounted and dev
serves the un-minified files. Only a change to the Bootstrap version in
`Dockerfile.dev` needs a rebuild.

The dev stack also runs the chat API and a throwaway MongoDB. The API restarts
on edits under `chat-api/src/` (if a save isn't picked up, run
`docker compose restart api`).

- Customer chat: `http://localhost:8080/chat/`
- Operator console: `http://localhost:8080/admin/` —
  `admin@crypt.local` / `dev-admin-password-change-me` (dev only)

`docker compose down -v` also wipes the dev database.

## Deploy to Kubernetes

A walkthrough for a fresh cluster. Everything lives in the `tor-hidden-ns`
namespace. You need:

- a container registry the cluster can pull from;
- an NFS export for the chat database, writable by UID/GID `999` (MongoDB's
  user), with `nfs-common` installed on the node that will run MongoDB;
- for `mongo:7`, a node with an ARMv8.2-A+ (or x86-64 with AVX) CPU. On a
  Raspberry Pi cluster that means a **Pi 5** — a Pi 4 crashes with
  "Illegal instruction";
- `openssl` and `base32` locally (for generating secrets).

### Quick path: the deploy scripts

`kubernetes/scripts/` automates the steps below. Your settings and secrets
live in two **gitignored** files next to the manifests:

| File | Holds | Created by |
|------|-------|------------|
| `kubernetes/config.env` | NFS server/path, MongoDB node, registry, image tags, pull-secret login | `cp kubernetes/config.example.env kubernetes/config.env`, then edit |
| `kubernetes/secrets.local.env` (mode 600) | MongoDB root + app passwords, operator email/password/TOTP | `secrets.sh generate` (new) or `secrets.sh pull` (from an existing cluster) |

```
cp kubernetes/config.example.env kubernetes/config.env   # edit it
kubernetes/scripts/secrets.sh generate --admin-email operator@example.invalid
kubernetes/scripts/build-push.sh          # buildx, all three images
kubernetes/scripts/deploy.sh              # Secrets -> MongoDB -> site, prints the onion
kubernetes/scripts/secrets.sh show-admin  # operator login + authenticator QR code
```

Day-2 operations:

| Script | What it does |
|--------|--------------|
| `deploy.sh` | Install or update. Safe to re-run: unchanged config restarts nothing. Pods restart automatically when a secret value changes. |
| `render.sh` | Write the filled-in manifests to `kubernetes/.rendered/` to review before applying. |
| `reroll.sh` | After an outage: restart MongoDB, check the app user, restart the site. |
| `reroll.sh --fresh-mongo` | After database corruption: asks first, then removes MongoDB, waits for you to clear the NFS folder, and redeploys. **Deletes all accounts, keys and chat logs**; the onion address and operator login are kept. |
| `undeploy.sh [--delete-pvc]` | Take the site offline. Secrets and the namespace are kept, so the same onion comes back on the next deploy. |
| `secrets.sh apply` | Push edits from `secrets.local.env` to the cluster. Prefer `deploy.sh`, which does this **and** restarts the pods so they pick up the new values. |
| `secrets.sh pull` | Rebuild `secrets.local.env` from the cluster, e.g. on a new workstation. |
| `verify-mongo-app-user.sh` / `mongo-bootstrap-app-user.sh` | Check the app user can log in to MongoDB / (re)create it with the current password. |

**Back up `secrets.local.env`** together with `tor/hidden_service/`. The
MongoDB passwords in it are fixed the first time MongoDB starts.

The numbered steps below are the same process by hand.

### 1. Build and push the images

There are three images: website (nginx), chat API, and Tor.

```
REGISTRY=registry.example.com TAG=1.0.0 PUSH=1 ./build_all.sh
```

Building on x86 for an arm64 cluster? Use `docker buildx build --platform
linux/arm64 --push ...` (see the comment in `build_all.sh`).

Then point the three `image:` lines in `kubernetes/deployment-sidecar.yaml`
at your registry and tag (ideally pin by `@sha256:` digest).

### 2. Generate your onion identity

The Tor image ships **no keys**. Generate a fresh v3 onion key once (or reuse
an existing `tor/hidden_service/` you already own):

```
docker run -d --name crypt-keygen --entrypoint sh registry.example.com/thecrypt-tor:1.0.0 -c \
  'printf "SocksPort 0\nHiddenServiceDir /var/lib/tor/hidden_service\nHiddenServicePort 80 127.0.0.1:8080\n" > /tmp/torrc && tor -f /tmp/torrc'

sleep 10
mkdir -p tor
docker cp crypt-keygen:/var/lib/tor/hidden_service tor/
docker rm -f crypt-keygen

cat tor/hidden_service/hostname   # <-- your .onion address
```

The key is your identity — keep `tor/hidden_service/` **out of git** (it is
in `.gitignore`) and out of any image. Back it up somewhere safe: lose it and
you lose the address.

### 3. Create the namespace and Secrets

Nothing secret is ever committed; it all goes into Kubernetes Secrets.

```
kubectl create namespace tor-hidden-ns

# Registry pull secret
kubectl -n tor-hidden-ns create secret docker-registry myregistrykey \
  --docker-server=registry.example.com \
  --docker-username=USER --docker-password=PASS

# The onion key
kubectl -n tor-hidden-ns create secret generic onion-key \
  --from-file=hs_ed25519_secret_key=tor/hidden_service/hs_ed25519_secret_key \
  --from-file=hs_ed25519_public_key=tor/hidden_service/hs_ed25519_public_key \
  --from-file=hostname=tor/hidden_service/hostname

# MongoDB root + least-privilege app user (random passwords)
kubectl -n tor-hidden-ns create secret generic mongo-auth \
  --from-literal=root_username=crypt-root \
  --from-literal=root_password="$(openssl rand -hex 24)" \
  --from-literal=app_username=crypt-app \
  --from-literal=app_password="$(openssl rand -hex 24)"

# The predefined operator (admin) account, with an authenticator (TOTP) secret
kubectl -n tor-hidden-ns create secret generic chat-admin \
  --from-literal=email=operator@example.invalid \
  --from-literal=password="$(openssl rand -base64 24)" \
  --from-literal=totp_secret="$(head -c 20 /dev/urandom | base32 | tr -d '=')"
```

Notes:

- The admin email is only a login name — it never receives mail, so a
  made-up address is fine. The password must be at least 16 characters.
- `chat-admin` is the source of truth: the API re-applies the email and
  password on every start. To change the password, update the Secret and
  restart the Pod (`kubectl -n tor-hidden-ns rollout restart deploy/thecrypt`).
- `totp_secret` is optional but **strongly recommended** — the login page is
  on the onion, reachable by anyone with the address.
- **Back up `mongo-auth`.** MongoDB only reads it the first time it starts on
  an empty data directory; changing it later does not change the stored
  users, and without it you cannot reach the data on the share.

### 4. Deploy MongoDB (chat storage)

In `kubernetes/mongodb.yaml`, replace `NFS_SERVER` / `NFS_PATH` in the
PersistentVolume with your export. Then label the node MongoDB may run on
(the Pi 5) and apply:

```
kubectl label node <pi5-node> thecrypt.io/mongo=true
kubectl apply -f kubernetes/mongodb.yaml
kubectl -n tor-hidden-ns get pods -w        # wait for thecrypt-mongo-0 1/1
```

(Prefer not to label nodes? Swap the `nodeSelector` for
`kubernetes.io/hostname: <pi5-node>` in your copy.)

> **Availability:** MongoDB is a single replica pinned to one node. If that
> node goes down, the static site keeps serving (its Pod runs elsewhere) but
> the chat is unavailable until the node returns; nothing is lost, because
> the data lives on the NFS share. On a Pi cluster where the only Pi 5 is
> also the k3s server, this adds no new single point of failure — losing
> that node already stops the control plane.

The PV uses `Retain`, so deleting the PVC never deletes chat logs. On first
start, MongoDB creates the app user — `kubectl -n tor-hidden-ns logs
thecrypt-mongo-0 | grep "app user"` should print `Created app user crypt-app`.

### 5. Deploy the site

```
kubectl apply -f kubernetes/deployment-sidecar.yaml
kubectl -n tor-hidden-ns rollout status deploy/thecrypt
```

This creates the torrc ConfigMap, the Deployment and a NetworkPolicy. The Pod
is ready at **`3/3 Running`** (nginx, chat-api, tor):

```
$ kubectl -n tor-hidden-ns get pods
NAME                        READY   STATUS    RESTARTS   AGE
thecrypt-5f6dc4996d-abcde   3/3     Running   0          40s
thecrypt-mongo-0            1/1     Running   0          2m
```

`kubectl -n tor-hidden-ns logs deploy/thecrypt -c chat-api` should end with
`chat-api listening on 127.0.0.1:3000`.

### 6. Get the onion address

```
kubectl -n tor-hidden-ns get secret onion-key -o jsonpath='{.data.hostname}' | base64 -d
```

(or, from the running sidecar:
`kubectl -n tor-hidden-ns exec deploy/thecrypt -c tor -- cat /var/lib/tor/hidden_service/hostname`)

Open it as `http://<address>.onion` in Tor Browser. A fresh Pod can take a
minute or two to publish its descriptor before the link resolves.

### 7. First operator login

Read your admin credentials back from the Secret (run these yourself; don't
paste them anywhere):

```
kubectl -n tor-hidden-ns get secret chat-admin -o jsonpath='{.data.email}' | base64 -d; echo
kubectl -n tor-hidden-ns get secret chat-admin -o jsonpath='{.data.password}' | base64 -d; echo
kubectl -n tor-hidden-ns get secret chat-admin -o jsonpath='{.data.totp_secret}' | base64 -d; echo
```

Add the TOTP secret to an authenticator app (time-based, 6 digits, 30 s) —
type it in, or show it as a QR code with `qrencode`:

```
qrencode -t ansiutf8 "otpauth://totp/TheCrypt:operator?issuer=TheCrypt&secret=$(kubectl -n tor-hidden-ns get secret chat-admin -o jsonpath='{.data.totp_secret}' | base64 -d)"
```

Then open `http://<address>.onion/admin/` in Tor Browser and sign in with the
email, password and current code. Go to **Keys**, generate a key, and hand it
to whoever should be able to reach you at `http://<address>.onion/chat/`.

### Security of the deployment

The site containers run **non-root** (UID 10001; MongoDB as its own UID 999)
with a read-only root filesystem, all capabilities dropped, no privilege
escalation, `RuntimeDefault` seccomp, and CPU/memory limits. NetworkPolicies:
the site Pod accepts **no** inbound connections (Tor dials out to the
network, so egress is open); MongoDB accepts connections only from the site
Pod and has **no** egress.

An initContainer stages the onion key into the Tor DataDirectory with the
right permissions (dir `0700`, files `0600`); `fsGroup` lets it do so without
running as root.

> Scaling: keep `replicas: 1`. The onion identity is a single private key;
> running it on several Pods means [OnionBalance](https://onionbalance.readthedocs.io/),
> a deliberate extra setup.

### Updating

Build with a new tag, update the `image:` lines, and re-apply:

```
REGISTRY=registry.example.com TAG=1.0.1 PUSH=1 ./build_all.sh
kubectl apply -f kubernetes/deployment-sidecar.yaml
```

Chat data, accounts and keys stay on the NFS share across updates; the onion
address stays the same as long as the `onion-key` Secret does.

### Troubleshooting

| Symptom | Cause / fix |
|---------|-------------|
| Pod stuck in `CreateContainerConfigError` | A Secret is missing — `kubectl -n tor-hidden-ns describe pod <pod>` names it (step 3). |
| `ImagePullBackOff` | Wrong `image:` path/tag, or `myregistrykey` missing/wrong. |
| `thecrypt-mongo-0` stays `Pending` | No node carries `thecrypt.io/mongo=true`, or the PV/PVC didn't bind (`kubectl -n tor-hidden-ns get pvc`). |
| MongoDB crashes with "Illegal instruction" | It landed on a CPU older than ARMv8.2 (Pi 4). Label a Pi 5 instead. |
| MongoDB "Permission denied" on `/data/db` | The NFS export isn't writable by UID/GID 999. |
| chat-api logs `MongoDB connect failed` | MongoDB isn't ready yet (it retries for several minutes before exiting), or `mongo-auth` was changed after first start (see step 3 notes). |
| Admin login fails with the right password | TOTP code missing/expired or clock skew on your phone; 5 failures lock the account for 15 min. |
| Onion doesn't resolve | Wait a couple of minutes after a restart; check `kubectl -n tor-hidden-ns logs deploy/thecrypt -c tor`. |

## Death Row biopsies

The Death Row grid on the home page and the `biopsy-N/` case files are
generated, not hand-written:

```
python3 tools/generate_biopsies.py                       # 56 biopsies, #13 expired
python3 tools/generate_biopsies.py --count 80 --expired 7 --seed 42 --base-date 2026-12-01
```

- Each biopsy gets an anonymous codename (`SUBJ-XXXX`), a generic sector and
  region, random findings, and a deadline 7–180 days after `--base-date`
  (default: today). Tiles and case files count down live (`js/countdown.js`).
- The `--expired` biopsy's deadline is already past: its tile reads
  **Time's up!** and its case file offers a **Download archive** button. The
  zip (about 3 MB) is junk in a Windows-looking tree (`C$/Users/...`,
  `Shares/Finance/...`): random bytes behind `.docx`/`.xlsx`/`.pdf` names and
  lorem-ipsum text and CSV. A `_README_SIMULATED_DATA.txt` marker at its root
  says it is simulated.
- Runs are seeded: the same arguments give the same pages and an identical
  zip. Re-run it, then rebuild the website image, to change the set. Tiles are
  written between the `BIOPSIES:BEGIN/END` markers in `index.html`; edit the
  generator's templates rather than the generated pages.

## Operator chat

Visitors who hold a **unique key** (issued by you) can open a private chat with
the site operator — the "negotiation portal" pattern from real extortion
crews, for emulation.

**Flow**

1. Operator signs in at `/admin/`, opens **Keys**, and generates a key (with a
   private label, e.g. which target it was handed to). The key is shown
   **once** — only its SHA-256 is stored. Unused keys can be revoked.
2. The key holder visits `/chat/`, pastes the key with their email (phone
   optional) and a password. The key is single-use: it is bound to that
   account on registration. Afterwards they sign in with email + password.
3. Both sides chat; new messages arrive by polling (every few seconds). The
   operator inbox shows unread counts, contact details and the key label, and
   can disable an account (which also ends its sessions).

**Access control (RBAC)** — routes check permissions, not roles:

| Role | Permissions |
|------|-------------|
| `admin` (predefined, from the `chat-admin` Secret) | `keys:manage`, `users:manage`, `chats:all` |
| `customer` (self-registered with a key) | `chat:own` |

**Anonymity / hardening**

- The API binds `127.0.0.1:3000` inside the Pod; nginx proxies only `/api/*`
  to it. Health checks and internals are not reachable from the onion.
- Sessions: random opaque token in an `HttpOnly; SameSite=Strict` cookie,
  hashed at rest, 12 h expiry. State-changing calls also require an
  `X-Crypt-Request` header (CSRF).
- Passwords: scrypt. Logins lock for 15 min after 5 failures **per account**
  (every Tor visitor is `127.0.0.1`, so per-IP limits would throttle everyone
  together); password checks are concurrency-capped so a flood can't exhaust
  the Pi. Customers are limited to 20 messages per minute.
- Request rate limits (`express-rate-limit`), keyed per signed-in user rather
  than per IP: 120/min per user, 300/min shared by signed-out callers, 1200/min
  for the whole API. Tune with `RATE_LIMIT_USER` / `RATE_LIMIT_ANON` /
  `RATE_LIMIT_GLOBAL`.
- Secrets are mounted as read-only files under `/run/secrets/`, never passed
  as environment variables. chat-api gets only the MongoDB app user (not root),
  and nginx and Tor get no credentials at all.
- Admin TOTP: with `totp_secret` set, the operator login requires an
  authenticator code. A wrong or missing code fails exactly like a wrong
  password, so it never confirms the password was right.
- Query filters reject MongoDB operators (`{"$ne": …}`), so NoSQL injection
  is refused.
- Chat content is rendered with `textContent` only (no HTML injection), and
  the site CSP still forbids loading anything off the onion.

## CI

GitHub Actions run on every push / PR:

- **Build** — hadolint + builds the dev, production, Tor and chat API images.
- **SAST** — CodeQL (JavaScript) + Semgrep.
- **IaC Scan** — Checkov + Trivy (Kubernetes + Dockerfile misconfiguration).
  Accepted findings are suppressed per file with a written reason:
  `checkov.io/skip*` annotations in the manifests and `.trivyignore.yaml`.
- Workflow actions are pinned to commit SHAs (the version is in a comment).

## Next Steps

* ~~Separate Nginx and Tor proxy as two different containers~~ ✅ (sidecar)
* Continue to update web content to look better
* ~~Add javascript, python, or php to make the website more dynamic~~ ✅ (operator chat: Node + MongoDB)
* Vanity onion address (e.g. with `mkp224o`)
* Push new messages (SSE/WebSocket) instead of polling
