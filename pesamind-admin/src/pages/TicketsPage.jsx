import { useEffect, useState } from "react";
import { Plus, X } from "lucide-react";
import { adminApi } from "../api.js";
import { Card, Badge, Button, Input, Select, Spinner, Pagination, EmptyState } from "../components/ui.jsx";

const STATUS_TONE = { open: "bad", in_progress: "warn", resolved: "good", closed: "neutral" };
const CATEGORY_LABEL = { dispute: "Dispute", inquiry: "Inquiry", complaint: "Complaint", fraud: "Fraud" };

function NewTicketModal({ onClose, onCreated }) {
  const [userId, setUserId] = useState("");
  const [category, setCategory] = useState("dispute");
  const [subject, setSubject] = useState("");
  const [description, setDescription] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true); setError("");
    try {
      await adminApi.tickets.create({ userId, category, subject, description });
      onCreated();
      onClose();
    } catch (err) {
      setError(err.message || "Couldn't log this request.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center px-4">
      <div className="absolute inset-0 bg-ink/40" onClick={onClose} />
      <div className="relative w-full max-w-md bg-white rounded-2xl shadow-2xl p-6">
        <div className="flex items-center justify-between mb-4">
          <p className="text-[15px] font-bold font-display text-ink">Log a customer request</p>
          <button onClick={onClose} className="p-1 rounded-full hover:bg-bgSoft"><X size={18} /></button>
        </div>
        <form onSubmit={submit}>
          <label className="block text-[12px] font-medium text-inkSoft mb-1.5">Customer user ID</label>
          <Input required value={userId} onChange={(e) => setUserId(e.target.value)} placeholder="Paste from the Users page" className="mb-3" />
          <label className="block text-[12px] font-medium text-inkSoft mb-1.5">Category</label>
          <Select value={category} onChange={(e) => setCategory(e.target.value)} className="mb-3">
            {Object.entries(CATEGORY_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </Select>
          <label className="block text-[12px] font-medium text-inkSoft mb-1.5">Subject</label>
          <Input required value={subject} onChange={(e) => setSubject(e.target.value)} placeholder="Short summary" className="mb-3" />
          <label className="block text-[12px] font-medium text-inkSoft mb-1.5">Details</label>
          <textarea required value={description} onChange={(e) => setDescription(e.target.value)} rows={4} className="w-full px-3.5 py-2.5 rounded-lg border border-border bg-white text-[13.5px] text-ink mb-4 focus:outline-none focus:ring-2 focus:ring-accent/30 focus:border-accent" placeholder="What did the customer report?" />
          {error && <p className="text-[12.5px] text-danger mb-3">{error}</p>}
          <Button type="submit" variant="accent" disabled={busy} className="w-full">{busy ? "Logging…" : "Log request"}</Button>
        </form>
      </div>
    </div>
  );
}

function TicketDetail({ ticket, canManage, onClose, onUpdated }) {
  const [status, setStatus] = useState(ticket.status);
  const [notes, setNotes] = useState(ticket.resolutionNotes || "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const save = async () => {
    setBusy(true); setError("");
    try {
      await adminApi.tickets.update(ticket.id, { status, resolutionNotes: notes });
      onUpdated();
      onClose();
    } catch (err) {
      setError(err.message || "Couldn't update this request.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-40 flex justify-end">
      <div className="absolute inset-0 bg-ink/40" onClick={onClose} />
      <div className="relative w-full max-w-md bg-white h-full overflow-y-auto shadow-2xl">
        <div className="sticky top-0 bg-white border-b border-border px-6 py-4 flex items-center justify-between">
          <p className="text-[15px] font-bold font-display text-ink">Request detail</p>
          <button onClick={onClose} className="p-1.5 rounded-full hover:bg-bgSoft"><X size={18} /></button>
        </div>
        <div className="p-6">
          <Badge tone={STATUS_TONE[ticket.status]}>{ticket.status.replace("_", " ")}</Badge>
          <p className="text-[16px] font-bold text-ink mt-3">{ticket.subject}</p>
          <p className="text-[12.5px] text-inkFaint mb-1">{CATEGORY_LABEL[ticket.category]} · {ticket.user?.firstName} {ticket.user?.lastName} · +255 {ticket.user?.phone}</p>
          <p className="text-[12px] text-inkFaint mb-4">Logged {new Date(ticket.createdAt).toLocaleString()}</p>
          <Card className="p-4 mb-4">
            <p className="text-[13px] text-ink whitespace-pre-wrap">{ticket.description}</p>
          </Card>

          {canManage ? (
            <>
              <label className="block text-[12px] font-medium text-inkSoft mb-1.5">Status</label>
              <Select value={status} onChange={(e) => setStatus(e.target.value)} className="mb-3">
                <option value="open">Open</option>
                <option value="in_progress">In progress</option>
                <option value="resolved">Resolved</option>
                <option value="closed">Closed</option>
              </Select>
              <label className="block text-[12px] font-medium text-inkSoft mb-1.5">Resolution notes</label>
              <textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={4} className="w-full px-3.5 py-2.5 rounded-lg border border-border bg-white text-[13.5px] text-ink mb-4 focus:outline-none focus:ring-2 focus:ring-accent/30 focus:border-accent" placeholder="What was done to resolve this?" />
              {error && <p className="text-[12.5px] text-danger mb-3">{error}</p>}
              <Button variant="accent" disabled={busy} onClick={save} className="w-full">{busy ? "Saving…" : "Save changes"}</Button>
            </>
          ) : (
            ticket.resolutionNotes && (
              <>
                <p className="text-[12px] font-medium text-inkSoft mb-1.5">Resolution notes</p>
                <p className="text-[13px] text-ink whitespace-pre-wrap">{ticket.resolutionNotes}</p>
              </>
            )
          )}
        </div>
      </div>
    </div>
  );
}

export default function TicketsPage({ user }) {
  const pageSize = 20;
  const canManage = user.role !== "admin_viewer";
  const [statusFilter, setStatusFilter] = useState("");
  const [tickets, setTickets] = useState([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState(null);
  const [showNew, setShowNew] = useState(false);

  const load = () => {
    setLoading(true);
    adminApi.tickets.list({ status: statusFilter }, page, pageSize).then((r) => { setTickets(r.tickets); setTotal(r.total); }).finally(() => setLoading(false));
  };
  useEffect(() => { load(); }, [page, statusFilter]);

  return (
    <div>
      <div className="flex items-center justify-between mb-1">
        <h1 className="text-[22px] font-bold font-display text-ink">Requests & disputes</h1>
        {canManage && <Button variant="accent" onClick={() => setShowNew(true)} className="flex items-center gap-1.5"><Plus size={14} /> Log a request</Button>}
      </div>
      <p className="text-[13.5px] text-inkFaint mb-6">Customer-raised issues, plus anything logged after a support call.</p>

      <div className="flex gap-2 mb-5">
        <Select value={statusFilter} onChange={(e) => { setStatusFilter(e.target.value); setPage(1); }} className="max-w-[200px]">
          <option value="">All statuses</option>
          <option value="open">Open</option>
          <option value="in_progress">In progress</option>
          <option value="resolved">Resolved</option>
          <option value="closed">Closed</option>
        </Select>
      </div>

      {loading ? (
        <div className="flex justify-center py-16"><Spinner /></div>
      ) : (
        <Card className="overflow-hidden">
          <table className="w-full text-left">
            <thead>
              <tr className="border-b border-border bg-bgSoft/60">
                <th className="px-5 py-3 text-[11px] font-semibold text-inkFaint uppercase tracking-wide">Subject</th>
                <th className="px-5 py-3 text-[11px] font-semibold text-inkFaint uppercase tracking-wide">Customer</th>
                <th className="px-5 py-3 text-[11px] font-semibold text-inkFaint uppercase tracking-wide">Category</th>
                <th className="px-5 py-3 text-[11px] font-semibold text-inkFaint uppercase tracking-wide">Status</th>
                <th className="px-5 py-3 text-[11px] font-semibold text-inkFaint uppercase tracking-wide">Logged</th>
              </tr>
            </thead>
            <tbody>
              {tickets.map((t) => (
                <tr key={t.id} onClick={() => setSelected(t)} className="border-b border-border last:border-0 hover:bg-bgSoft/50 cursor-pointer">
                  <td className="px-5 py-3.5 text-[13px] font-semibold text-ink">{t.subject}</td>
                  <td className="px-5 py-3.5 text-[12.5px] text-inkSoft">{t.user?.firstName} {t.user?.lastName}</td>
                  <td className="px-5 py-3.5 text-[12.5px] text-inkSoft">{CATEGORY_LABEL[t.category]}</td>
                  <td className="px-5 py-3.5"><Badge tone={STATUS_TONE[t.status]}>{t.status.replace("_", " ")}</Badge></td>
                  <td className="px-5 py-3.5 text-[12.5px] text-inkFaint">{new Date(t.createdAt).toLocaleDateString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {tickets.length === 0 && <EmptyState title="Nothing here" sub="No requests match this filter." />}
        </Card>
      )}
      {!loading && total > 0 && <Pagination page={page} pageSize={pageSize} total={total} onPageChange={setPage} />}

      {selected && <TicketDetail ticket={selected} canManage={canManage} onClose={() => setSelected(null)} onUpdated={load} />}
      {showNew && <NewTicketModal onClose={() => setShowNew(false)} onCreated={load} />}
    </div>
  );
}
