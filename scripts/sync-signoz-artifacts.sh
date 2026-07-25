#!/usr/bin/env bash
#
# Compiles the active contract of every agent in a project into managed SigNoz artefacts and waits
# for the jobs to finish. Requires a running API (`make api`) and worker (`make worker`).
#
#   PROJECT=demo-commerce make signoz-sync
set -euo pipefail

API="${API_URL:-http://localhost:4000}"
PROJECT="${PROJECT:-demo-commerce}"

project_id=$(curl -fsS "${API}/api/projects" |
  python3 -c "
import sys, json
slug = '${PROJECT}'
items = json.load(sys.stdin).get('items', [])
match = next((p for p in items if p['slug'] == slug), None)
if match is None:
    sys.stderr.write(f'no project with slug {slug}\n')
    raise SystemExit(1)
print(match['id'])
")

printf 'syncing SigNoz artefacts for %s (%s)\n' "${PROJECT}" "${project_id}"

response=$(curl -fsS -X POST "${API}/api/setup/signoz/sync-artifacts" \
  -H 'content-type: application/json' \
  -d "{\"projectId\":\"${project_id}\"}")

echo "${response}" | python3 -c "
import sys, json
body = json.load(sys.stdin)
for job in body['jobs']:
    print(f\"queued {job['jobId']} for agent {job['agentId']} (created={job['created']})\")
for skipped in body['skipped']:
    print(f\"skipped agent {skipped['agentId']}: {skipped['reason']}\")
" | tee /dev/stderr >/dev/null

for job_id in $(echo "${response}" | python3 -c "
import sys, json
for job in json.load(sys.stdin)['jobs']:
    print(job['jobId'])
"); do
  while true; do
    status=$(curl -fsS "${API}/api/jobs/${job_id}" |
      python3 -c "import sys, json; print(json.load(sys.stdin)['status'])")
    case "${status}" in
      succeeded) break ;;
      failed|cancelled)
        curl -fsS "${API}/api/jobs/${job_id}" |
          python3 -c "import sys, json; print(json.dumps(json.load(sys.stdin).get('error'), indent=1))"
        printf 'sync job %s %s\n' "${job_id}" "${status}" >&2
        exit 1
        ;;
      *) sleep 2 ;;
    esac
  done
done

curl -fsS "${API}/api/setup/signoz/artifacts?projectId=${project_id}" | python3 -c "
import sys, json
body = json.load(sys.stdin)
for item in body['items']:
    print(f\"{item['status']:8} {item['lastOperation'] or '-':10} {item['managedName']}\")
print()
print('summary:', json.dumps(body['summary']))
"
