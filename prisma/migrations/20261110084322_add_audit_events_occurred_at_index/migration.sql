-- CreateIndex
CREATE INDEX "audit_events_occurred_at_event_id_idx" ON "audit_events"("occurred_at", "event_id");
