import { useEffect, useState } from "react";
import { StatCard, Spinner, fmtTZS } from "../components/ui.jsx";
import { adminApi } from "../api.js";

export default function DashboardPage({ user }) {
  const [stats, setStats] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    adminApi.dashboard()
      .then(setStats)
      .catch((err) => setError(err.message || "Couldn't load the dashboard."))
      .finally(() => setLoading(false));
  }, []);

  return (
    <div>
      <h1 className="text-[22px] font-bold font-display text-ink mb-1">Dashboard</h1>
      <p className="text-[13.5px] text-inkFaint mb-6">Welcome back, {user.firstName}. Here's what's happening across PesaMind.</p>

      {loading ? (
        <div className="flex justify-center py-16"><Spinner /></div>
      ) : error ? (
        <p className="text-[13px] text-danger">{error}</p>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          <StatCard label="Mobile app users" value={stats.totalUsers.toLocaleString()} />
          <StatCard label="Active in last 30 days" value={stats.activeUsers30d.toLocaleString()} tone="accent" hint={`${stats.totalUsers ? Math.round((stats.activeUsers30d / stats.totalUsers) * 100) : 0}% of all users`} />
          <StatCard label="New this month" value={stats.newUsersThisMonth.toLocaleString()} tone="gold" />
          <StatCard label="Blocked accounts" value={stats.blockedUsers.toLocaleString()} tone={stats.blockedUsers > 0 ? "danger" : "ink"} />
          <StatCard label="KYC verified" value={stats.kycVerified.toLocaleString()} tone="accent" />
          <StatCard label="KYC pending" value={stats.kycPending.toLocaleString()} tone="gold" />
          <StatCard label="Open requests & disputes" value={stats.openTickets.toLocaleString()} tone={stats.openTickets > 0 ? "danger" : "ink"} />
          {stats.totalCardBalance !== null && <StatCard label="Total balance on platform" value={fmtTZS(stats.totalCardBalance)} />}
        </div>
      )}
    </div>
  );
}
