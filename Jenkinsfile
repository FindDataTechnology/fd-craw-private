// ── Platform (paas) — build image on the cheap cluster, push to Harbor ────────
//
// Runs on the built-in agent: the Jenkins pod on cheap-3 with the host's docker
// CLI + /var/run/docker.sock mounted, so `docker build` uses cheap-3's daemon —
// the one whose daemon.json already lists 100.64.0.8:30880 as an insecure
// registry. Nothing here talks to Docker Hub, which cheap-3 cannot reach.
//
// This is the alternative to .github/workflows/docker-deploy.yml (which builds
// on a GitHub runner and pushes to the America Harbor): that leg is both
// cross-border and GFW-throttled, and its cached cold build was slow enough to
// need a 240m ceiling. On-LAN, the registry is a few hops away.
//
// The image is the same artifact the workflow produces — same `sha-<7>` +
// `latest` tags — so either path feeds the same manifests.
//
// Credential `harbor-platform` is the Harbor robot `robot$paas_private+ci-push-platform`
// (project-scoped to paas_private, push + pull, no expiry).

pipeline {
  agent any

  options {
    timestamps()
    // Cold builds are the norm, not the exception: native addons (better-sqlite3,
    // tree-sitter) compile from source, scripts/build-node.js downloads a
    // standalone Node release, and vite builds the SPA — and nothing is cached
    // between runs (no BuildKit cache export here). Generous ceiling on purpose;
    // a false timeout throws away 40 minutes of work.
    timeout(time: 120, unit: 'MINUTES')
    // Two builds would fight over the same `latest` tag AND over cheap-3's
    // ~9 GB of free disk, which it shares with the running platform pod.
    disableConcurrentBuilds()
    buildDiscarder(logRotator(numToKeepStr: '20'))
  }

  environment {
    REGISTRY   = '100.64.0.8:30880'
    IMAGE      = '100.64.0.8:30880/paas_private/platform'
    // cheap-3 cannot reach registry-1.docker.io, so the Dockerfile's default
    // (node:25-bookworm-slim) is overridden with the cluster's own mirror.
    BASE_IMAGE = '100.64.0.8:30880/library/node:25-bookworm-slim'
  }

  stages {
    stage('Resolve tag') {
      steps {
        script {
          env.GIT_SHA = sh(returnStdout: true, script: 'git rev-parse --short=7 HEAD').trim()
          env.TAG = "sha-${env.GIT_SHA}"
          echo "Building ${env.IMAGE}:${env.TAG}"
        }
      }
    }

    stage('Build') {
      steps {
        sh 'docker build --build-arg BASE_IMAGE="$BASE_IMAGE" -t "$IMAGE:$TAG" -t "$IMAGE:latest" -f Dockerfile .'
      }
    }

    stage('Push to Harbor') {
      steps {
        withCredentials([usernamePassword(credentialsId: 'harbor-platform',
                                          usernameVariable: 'HARBOR_USER',
                                          passwordVariable: 'HARBOR_PASS')]) {
          sh '''
            set -e
            echo "$HARBOR_PASS" | docker login "$REGISTRY" -u "$HARBOR_USER" --password-stdin
            docker push "$IMAGE:$TAG"
            docker push "$IMAGE:latest"
          '''
        }
      }
    }
  }

  post {
    always { sh 'docker logout "$REGISTRY" || true' }
    // The tag is what the ArgoCD manifest needs to reference; it is deliberately
    // not bumped here (same as law-bench) — the platform manifest is committed by
    // hand so a deploy is always a reviewable commit.
    success { echo "Pushed ${IMAGE}:${TAG} — set this tag in fd-infra-deploy/all-services/prod/platform.yaml" }
  }
}
