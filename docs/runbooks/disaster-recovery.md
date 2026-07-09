# Disaster Recovery Runbook

> **Scope:** Operational steps for restoring Minions Agent Framework v1 services after failures.  
> **Audience:** On-call engineer or platform operator.  
> **Prerequisites:** Azure CLI (`az`), `kubectl` (if inspecting Container Apps), `sqlite3`, access to the production resource group and Key Vault.

---

## Quick reference

| Scenario | First action | Target RTO | Section |
|---|---|---|---|
| Orchestrator replica crash | Verify KEDA respawn | < 2 min | [Orchestrator replica crash](#orchestrator-replica-crash) |
| SQLite corruption or data loss | Restore latest Blob backup | < 10 min | [Restore SQLite from Blob](#restore-sqlite-from-blob) |
| Service Bus DLQ build-up | Replay from dashboard or CLI | < 15 min | [Replay Service Bus DLQ](#replay-service-bus-dlq) |
| Availability zone failure | Confirm failover to surviving zones | < 5 min | [Availability zone failure](#availability-zone-failure) |
| Full region failure | Invoke manual region failover (future scope) | 2–4 hours | [Region failover](#region-failover) |

---

## Orchestrator replica crash

1. Check Container Apps replica status:
   ```bash
   az containerapp revision list \
     --name ca-goosefw-orchestrator \
     --resource-group rg-goosefw-prod \
     --query "[?active].name" -o tsv
   ```
2. If replica count is zero or unhealthy, KEDA should respawn automatically. Verify scale rule:
   ```bash
   az containerapp show \
     --name ca-goosefw-orchestrator \
     --resource-group rg-goosefw-prod \
     --query "properties.configuration.scale"
   ```
3. Tail logs to confirm startup and SQLite restore:
   ```bash
   az containerapp logs show \
     --name ca-goosefw-orchestrator \
     --resource-group rg-goosefw-prod \
     --tail 50
   ```
4. Expected log line within 30 seconds: `SQLite restored from Blob; resuming sessions`.

---

## Restore SQLite from Blob

Use this when the SQLite database is corrupted, missing, or needs to be rolled back.

1. Identify the latest backup:
   ```bash
   LATEST=$(az storage blob list \
     --container-name sqlite-backups \
     --account-name stgoosefwprod \
     --prefix orchestrator/ \
     --query "sort_by([], &properties.lastModified)[-1].name" -o tsv)
   echo "Latest backup: $LATEST"
   ```
2. Stop the orchestrator (scale to zero):
   ```bash
   az containerapp update \
     --name ca-goosefw-orchestrator \
     --resource-group rg-goosefw-prod \
     --min-replicas 0 --max-replicas 0
   ```
3. Download the backup to the persistent `/data` volume:
   ```bash
   az storage blob download \
     --container-name sqlite-backups \
     --name "$LATEST" \
     --file /data/goose-sessions.db \
     --account-name stgoosefwprod
   ```
4. Verify integrity:
   ```bash
   sqlite3 /data/goose-sessions.db "PRAGMA integrity_check;"
   ```
5. Restart the orchestrator:
   ```bash
   az containerapp update \
     --name ca-goosefw-orchestrator \
     --resource-group rg-goosefw-prod \
     --min-replicas 1 --max-replicas 5
   ```
6. Confirm the dashboard reports sessions from the restored database.

---

## Replay Service Bus DLQ

1. List dead-lettered messages:
   ```bash
   az servicebus deadletter list \
     --namespace-name sb-goosefw-prod \
     --topic-name minion-tasks \
     --subscription-name code-reviewer \
     --query "[].{MessageId:messageId, SequenceNumber:sequenceNumber}" \
     --output table
   ```
2. Inspect a specific message before replay:
   ```bash
   az servicebus deadletter peek \
     --namespace-name sb-goosefw-prod \
     --topic-name minion-tasks \
     --subscription-name code-reviewer \
     --sequence-number 12345
   ```
3. Replay the message:
   ```bash
   az servicebus deadletter resubmit \
     --namespace-name sb-goosefw-prod \
     --topic-name minion-tasks \
     --subscription-name code-reviewer \
     --sequence-numbers 12345
   ```
4. Monitor the orchestrator logs for successful processing.

---

## Availability zone failure

1. Confirm the Container Apps environment spans multiple zones:
   ```bash
   az containerapp env show \
     --name cae-goosefw-prod \
     --resource-group rg-goosefw-prod \
     --query "properties.zoneRedundant"
   ```
2. Confirm Storage is ZRS:
   ```bash
   az storage account show \
     --name stgoosefwprod \
     --query "sku.name"
   ```
3. Scale out replicas to surviving zones if KEDA has not already done so:
   ```bash
   az containerapp update \
     --name ca-goosefw-orchestrator \
     --resource-group rg-goosefw-prod \
     --min-replicas 2
   ```
4. Verify active message counts in Service Bus return to normal.

---

## Region failover

Multi-region active-passive is not implemented in v1. In a full region outage:

1. Deploy the Terraform stack to the secondary region:
   ```bash
   cd infra/terraform/environments/prod-west
   terraform apply
   ```
2. Restore SQLite from the latest Blob copy in the secondary region.
3. Update DNS/Slack/Teams bot endpoints to the secondary region URLs.
4. Notify users of the migration and expected degradation.

---

## Validation checklist

After any DR action, confirm:

- [ ] Dashboard `/health` returns `200 OK`
- [ ] Service Bus active message count is trending to zero
- [ ] SQLite `PRAGMA integrity_check;` returns `ok`
- [ ] A test Slack/Teams message receives a response
- [ ] Audit log shows tool calls resuming with correct correlation IDs
