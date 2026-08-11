# ── Platform container make targets ───────────────────────────────────────────
#
# Convenience wrapper around docker build/run + kubectl/argocd deploy.
# All targets are phony (no file outputs). Override variables on the command line:
#
#   make build                       # build the local image (tag: platform:dev)
#   make run                         # run it on :3000 with a named data volume
#   make logs                        # tail the running container
#   make stop                        # stop + rm the container (keeps the volume)
#   make shell                       # exec a shell in the running container
#
#   make k8s-apply                   # kubectl apply the k8s/ manifests directly
#   make k8s-deploy TAG=sha-abc1234  # set image tag + rollout restart
#   make k8s-status                  # pods + svc + rollout status
#   make k8s-logs                    # tail the platform pod
#
#   make argocd-sync                 # force an ArgoCD sync of the platform app
#
# Variables
IMAGE      ?= platform:dev
HARBOR     ?= harbor.local/paas_private/platform
DATA_VOLUME ?= platform-data-dev
KUBE_NS    ?= platform-private
ARGOCD_APP ?= platform
# kubectl context: set KUBECONFIG or use the SSH-reachable k3s. For local
# `kubectl` against the remote cluster, export KUBECONFIG to your k3s kubeconfig.

.PHONY: build run logs stop shell k8s-apply k8s-deploy k8s-status k8s-logs argocd-sync clean

# ── Local Docker ──────────────────────────────────────────────────────────────
build:
	docker build -t $(IMAGE) .

# Run the full-stack image: one container, server.js + LiteLLM + OpenConnector +
# Postgres as child processes. -e VOLCES_API_KEY optional (server.js has a
# fallback). The data volume persists /data across restarts.
run:
	docker run -d --name platform-dev \
	  -p 3000:3000 \
	  -v $(DATA_VOLUME):/data \
	  -e VOLCES_API_KEY="$(VOLCES_API_KEY)" \
	  $(IMAGE)
	@echo "Platform starting at http://localhost:3000 (cold start ~60-120s)"
	@echo "Tail logs: make logs"

logs:
	docker logs -f platform-dev

stop:
	docker stop platform-dev || true
	docker rm platform-dev || true

shell:
	docker exec -it platform-dev sh

# ── Kubernetes (remote k3s) ───────────────────────────────────────────────────
# Apply the manifests directly (bypassing ArgoCD) for a first deploy or testing.
# ArgoCD will subsequently adopt + self-heal these resources.
k8s-apply:
	kubectl apply -f k8s/ -n $(KUBE_NS)

# Set the deployment image to a specific tag and roll out. Defaults to :latest.
#   make k8s-deploy TAG=sha-abc1234
k8s-deploy:
	kubectl -n $(KUBE_NS) set image deployment/platform \
	  platform=$(HARBOR):$(TAG)
	kubectl -n $(KUBE_NS) rollout status deployment/platform

k8s-status:
	@echo "=== Pods ==="
	kubectl -n $(KUBE_NS) get pods -l app.kubernetes.io/name=platform
	@echo "=== Service ==="
	kubectl -n $(KUBE_NS) get svc platform
	@echo "=== Rollout ==="
	kubectl -n $(KUBE_NS) rollout status deployment/platform

k8s-logs:
	kubectl -n $(KUBE_NS) logs -f -l app.kubernetes.io/name=platform --tail=200

# ── ArgoCD ────────────────────────────────────────────────────────────────────
# Force a sync (normally auto-sync handles this). Requires `argocd` CLI logged in:
#   argocd login 23.144.68.246:30910 --username admin --password <pw> --insecure --grpc-web
argocd-sync:
	argocd app sync $(ARGOCD_APP) --force --wait --timeout 300

# ── Cleanup ───────────────────────────────────────────────────────────────────
clean: stop
	docker volume rm $(DATA_VOLUME) || true
