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
Dockerfile                    production website image (unprivileged nginx)
Dockerfile.dev                local dev image (live-editable)
docker-compose.yml            local dev stack
nginx-prod.conf / nginx-dev.conf / nginx-hardening.conf
container-images/tor-sidecar.dockerfile   keyless Tor image
kubernetes/deployment-sidecar.yaml        the deployment (nginx + tor sidecar)
build_all.sh                  builds both deployable images
```

## Local development

See the site locally with live editing — no Tor, served on
`http://localhost:8080`:

```
docker compose up --build        # or: docker compose up -d --build
docker compose down
```

Edit anything under `website/` (HTML, `css/custom-styles.css`,
`js/countdown.js`) and just refresh — the source tree is bind-mounted and dev
serves the un-minified files. Only a change to the Bootstrap version in
`Dockerfile.dev` needs a rebuild.

## Build the images

Both images are self-contained (Bootstrap is pulled from pinned npm dist, so
there are no separate build stages). Set the tags to your registry, then push:

```
./build_all.sh                               # tags :1.0.0 by default
# or: TAG=1.2.3 ./build_all.sh

docker push registry.yourregistry.com/thecrypt-website:1.0.0
docker push registry.yourregistry.com/thecrypt-tor:1.0.0
```

Update the two `image:` lines in `kubernetes/deployment-sidecar.yaml` to match
your registry/tag (ideally pin by `@sha256:` digest).

## Generate your onion identity

The Tor image ships **no keys**. Generate a fresh v3 onion key once (or reuse
an existing `tor/hidden_service/` you already own):

```
docker build -t registry.yourregistry.com/thecrypt-tor:1.0.0 -f container-images/tor-sidecar.dockerfile .

docker run -d --name crypt-keygen --entrypoint sh registry.yourregistry.com/thecrypt-tor:1.0.0 -c \
  'printf "SocksPort 0\nHiddenServiceDir /var/lib/tor/hidden_service\nHiddenServicePort 80 127.0.0.1:8080\n" > /tmp/torrc && tor -f /tmp/torrc'

sleep 10
mkdir -p tor
docker cp crypt-keygen:/var/lib/tor/hidden_service tor/
docker rm -f crypt-keygen

cat tor/hidden_service/hostname   # <-- your .onion address
```

The key is your identity — keep `tor/hidden_service/` **out of git** and out of
any image.

## Deploy to Kubernetes

```
# 1) Namespace + Deployment + ConfigMap + NetworkPolicy
kubectl apply -f kubernetes/deployment-sidecar.yaml

# 2) Registry pull secret
kubectl -n tor-hidden-ns create secret docker-registry myregistrykey \
  --docker-server=registry.yourregistry.com \
  --docker-username=USER --docker-password=PASS

# 3) The onion key (never committed)
kubectl -n tor-hidden-ns create secret generic onion-key \
  --from-file=hs_ed25519_secret_key=tor/hidden_service/hs_ed25519_secret_key \
  --from-file=hs_ed25519_public_key=tor/hidden_service/hs_ed25519_public_key \
  --from-file=hostname=tor/hidden_service/hostname
```

An initContainer stages the key into the Tor DataDirectory with the right
permissions (dir `0700`, files `0600`); `fsGroup` lets it do so without running
as root.

### Example

```
$ kubectl get all -n tor-hidden-ns
NAME                            READY   STATUS    RESTARTS   AGE
pod/thecrypt-6c9f8b7d5c-abcde   2/2     Running   0          40s

NAME                       READY   UP-TO-DATE   AVAILABLE   AGE
deployment.apps/thecrypt   1/1     1            1           40s
```

Both containers run **non-root** (UID 10001) with a read-only root filesystem,
all capabilities dropped, no privilege escalation, `RuntimeDefault` seccomp, and
CPU/memory limits. A `NetworkPolicy` denies all inbound and allows egress so Tor
can reach the network.

> Scaling: keep `replicas: 1`. The onion identity is a single private key;
> running it on several Pods means [OnionBalance](https://onionbalance.readthedocs.io/),
> a deliberate extra setup.

## CI

GitHub Actions run on every push / PR:

- **Build** — hadolint + builds the dev, production and Tor images.
- **SAST** — CodeQL (JavaScript) + Semgrep.
- **IaC Scan** — Checkov + Trivy (Kubernetes + Dockerfile misconfiguration).

## Next Steps

* ~~Separate Nginx and Tor proxy as two different containers~~ ✅ (sidecar)
* Continue to update web content to look better
* Add javascript, python, or php to make the website more dynamic. Preferably not php.
