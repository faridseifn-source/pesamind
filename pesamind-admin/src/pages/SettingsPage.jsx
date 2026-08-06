import { useEffect, useState } from "react";
import { Card, Button, Input, Spinner } from "../components/ui.jsx";
import { adminApi } from "../api.js";

const LABELS = {
  household_max_members: "Max household members per shared wallet",
  card_bin: "Card BIN prefix",
  cms_provider_label: "CMS provider label",
  partner_bank_acquirer_id: "Partner bank TIPS Acquirer ID",
  qr_test_samples_enabled: "QR test payment samples",
  qr_manual_payload_paste_enabled: "QR manual payload paste (dev only)",
  qr_step_up_threshold: "Step-up confirmation threshold (TZS)",
  cbs_simulated_failure_rate: "Simulated CBS failure rate (%)",
  tips_simulated_failure_rate: "Simulated TIPS failure rate (%)",
};
const HELP = {
  household_max_members: "Caps how many people can be invited to a single shared wallet.",
  card_bin: "6-digit prefix used when generating card numbers — mirrors how a real CMS ties a BIN to a card Product.",
  cms_provider_label: "Display-only label. Does not change which provider is active — that's set via an environment variable, not here.",
  partner_bank_acquirer_id: "5-digit TIPS Acquirer ID. A scanned QR matching this settles on-us; anything else routes via TIPS.",
  qr_test_samples_enabled: "\"true\" or \"false\" — turn off before customers use the live app.",
  qr_manual_payload_paste_enabled: "\"true\" or \"false\" — the raw-payload paste field is a developer convenience only. Turn off before launch.",
  qr_step_up_threshold: "Amounts above this (but under the KYC threshold) require password/biometric confirmation from the customer.",
  cbs_simulated_failure_rate: "0-100. Injects simulated CBS posting failures, for testing the automatic-reversal logic.",
  tips_simulated_failure_rate: "0-100. Injects simulated TIPS routing failures/pending states.",
};

export default function SettingsPage({ user }) {
  const canEdit = user.role === "admin_super";
  const [settings, setSettings] = useState(null);
  const [loading, setLoading] = useState(true);
  const [editingKey, setEditingKey] = useState(null);
  const [editValue, setEditValue] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const load = () => {
    setLoading(true); setError("");
    adminApi.settings.list().then(setSettings).catch((err) => setError(err.message)).finally(() => setLoading(false));
  };
  useEffect(() => { load(); }, []);

  const save = async (key) => {
    setSaving(true); setError("");
    try { await adminApi.settings.update(key, editValue); load(); setEditingKey(null); }
    catch (err) { setError(err.message || "Couldn't save."); }
    finally { setSaving(false); }
  };

  return (
    <div>
      <h1 className="text-[22px] font-bold font-display text-ink mb-1">Settings</h1>
      <p className="text-[13.5px] text-inkFaint mb-6">{canEdit ? "System-wide configuration — changes take effect immediately, no redeploy needed." : "Read-only for your access level."}</p>

      {loading ? (
        <div className="flex justify-center py-16"><Spinner /></div>
      ) : (
        <div className="space-y-3 max-w-xl">
          {error && <p className="text-[12.5px] text-danger">{error}</p>}
          {Object.entries(settings || {}).map(([key, value]) => (
            <Card key={key} className="p-5">
              <p className="text-[13px] font-semibold text-ink mb-0.5">{LABELS[key] || key}</p>
              <p className="text-[11.5px] text-inkFaint mb-3">{HELP[key] || ""}</p>
              {editingKey === key ? (
                <div className="flex gap-2">
                  <Input value={editValue} onChange={(e) => setEditValue(e.target.value)} />
                  <Button variant="accent" disabled={saving} onClick={() => save(key)}>{saving ? "…" : "Save"}</Button>
                  <Button variant="ghost" onClick={() => setEditingKey(null)}>Cancel</Button>
                </div>
              ) : (
                <div className="flex items-center justify-between">
                  <p className="text-[15px] font-bold font-mono text-ink">{value}</p>
                  {canEdit && <Button variant="ghost" onClick={() => { setEditingKey(key); setEditValue(value); }}>Edit</Button>}
                </div>
              )}
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
