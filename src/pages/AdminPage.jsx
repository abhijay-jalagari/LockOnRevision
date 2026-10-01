import { useTranslation } from "react-i18next";
import { Award, BookOpen, Search, ShieldCheck, Trophy, Users, Zap } from "lucide-react";
import { useEffect, useState } from "react";
import { Navigate } from "react-router-dom";
import { httpsCallable } from "firebase/functions";
import { StatCard } from "../components/StatCard.jsx";
import { EmptyState } from "../components/EmptyState.jsx";
import { useAuth } from "../context/AuthContext.jsx";
import { functions } from "../config/firebase.js";
import {
  adjustUserEnergy,
  adjustUserXp,
  fetchAllForgeSubjects,
  getAdminOverview,
  grantLeaderboardReward,
  moderateForgeSubject,
  searchUsers,
  setUserTotalScore,
} from "../services/adminService.js";
import { calculateTotalScore } from "../services/userService.js";
import { canAccessAdmin } from "../utils/permissions.js";

export function AdminPage() {
  const { t } = useTranslation();
  const { isFirebaseConfigured, profile } = useAuth();
  const [overview, setOverview] = useState(null);
  const [users, setUsers] = useState([]);
  const [forgeContent, setForgeContent] = useState([]);
  const [searchTerm, setSearchTerm] = useState("");
  const [selectedUserId, setSelectedUserId] = useState("");
  const [xpDelta, setXpDelta] = useState(100);
  const [energyDelta, setEnergyDelta] = useState(1);
  const [totalScoreInput, setTotalScoreInput] = useState("");
  const [rewardXp, setRewardXp] = useState(100);
  const [rewardEnergy, setRewardEnergy] = useState(1);
  const [rewardReason, setRewardReason] = useState(t("admin_page.manual_reward_event"));
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false);

  const isAdmin = canAccessAdmin(profile);
  const [serverVerified, setServerVerified] = useState(false);

  useEffect(() => {
    if (!isAdmin || !isFirebaseConfigured || !functions) return;
    const check = httpsCallable(functions, "verifyAdminAccess");
    check().then(() => {
      setServerVerified(true);
      getAdminOverview().then(setOverview).catch(() => setOverview({ available: false }));
      searchUsers("").then(setUsers).catch(() => setUsers([]));
      fetchAllForgeSubjects().then(setForgeContent).catch(() => setForgeContent([]));
    }).catch(() => {
      setServerVerified(false);
    });
  }, [isAdmin, isFirebaseConfigured]);

  if (!isAdmin) {
    return <Navigate to="/app" replace />;
  }

  if (!serverVerified) {
    return (
      <main className="grid min-h-screen place-items-center bg-background text-text-primary">
        <div className="h-12 w-12 animate-spin rounded-full border-4 border-primary/20 border-t-primary" />
      </main>
    );
  }

  const selectedUser = users.find((item) => item.id === selectedUserId);

  async function runSearch() {
    setBusy(true);
    setStatus("");
    try {
      const results = await searchUsers(searchTerm);
      setUsers(results);
      setStatus(t("admin_page.found_users", { count: results.length }));
    } catch (error) {
      setStatus(t("admin_page.operation_failed"));
      console.error("[AdminPage] Operation failed:", error);
    } finally {
      setBusy(false);
    }
  }

  async function runXpAdjust(sign) {
    if (!selectedUserId) return setStatus(t("admin_page.select_user_first"));
    setBusy(true);
    try {
      const result = await adjustUserXp(selectedUserId, sign * Number(xpDelta || 0));
      setStatus(t("admin_page.xp_updated", { score: result.totalScore.toLocaleString() }));
      setUsers(await searchUsers(searchTerm));
    } catch (error) {
      setStatus(t("admin_page.operation_failed"));
      console.error("[AdminPage] XP adjustment failed:", error);
    } finally {
      setBusy(false);
    }
  }

  async function runEnergyAdjust(sign) {
    if (!selectedUserId) return setStatus(t("admin_page.select_user_first"));
    setBusy(true);
    try {
      const result = await adjustUserEnergy(selectedUserId, sign * Number(energyDelta || 0));
      setStatus(t("admin_page.energy_updated", { score: result.totalScore.toLocaleString() }));
      setUsers(await searchUsers(searchTerm));
    } catch (error) {
      setStatus(t("admin_page.operation_failed"));
      console.error("[AdminPage] Energy adjustment failed:", error);
    } finally {
      setBusy(false);
    }
  }

  async function runTotalScoreSet() {
    if (!selectedUserId) return setStatus(t("admin_page.select_user_first"));
    setBusy(true);
    try {
      const result = await setUserTotalScore(selectedUserId, Number(totalScoreInput || 0));
      setStatus(t("admin_page.score_set", { score: result.totalScore.toLocaleString() }));
    } catch (error) {
      setStatus(t("admin_page.operation_failed"));
      console.error("[AdminPage] Score set failed:", error);
    } finally {
      setBusy(false);
    }
  }

  async function runRewardEvent() {
    if (!selectedUserId) return setStatus(t("admin_page.select_user_first"));
    setBusy(true);
    try {
      const result = await grantLeaderboardReward(selectedUserId, {
        xp: Number(rewardXp || 0),
        energy: Number(rewardEnergy || 0),
        reason: rewardReason,
      });
      setStatus(t("admin_page.reward_applied", { score: result.totalScore.toLocaleString() }));
      setUsers(await searchUsers(searchTerm));
    } catch (error) {
      setStatus(t("admin_page.operation_failed"));
      console.error("[AdminPage] Reward grant failed:", error);
    } finally {
      setBusy(false);
    }
  }

  async function removeForgeSubject(userId, subjectId) {
    setBusy(true);
    try {
      await moderateForgeSubject(userId, subjectId);
      setForgeContent(await fetchAllForgeSubjects());
      setStatus(t("admin_page.forge_subject_removed"));
    } catch (error) {
      setStatus(t("admin_page.operation_failed"));
      console.error("[AdminPage] Forge subject removal failed:", error);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="grid gap-6">
      <section className="overflow-hidden rounded-xl border border-border bg-surface shadow-sm">
        <div className="bg-gradient-to-r from-secondary to-primary p-6 text-white">
          <div className="flex items-center gap-3">
            <ShieldCheck size={24} />
            <div>
              <p className="text-sm font-bold uppercase tracking-widest text-white/75">{t("nav.admin")}</p>
              <h1 className="text-4xl font-black tracking-tight">{t("admin.title")}</h1>
            </div>
          </div>
          <p className="mt-3 max-w-2xl text-white/85">{t("admin.description")}</p>
        </div>
      </section>

      {!isFirebaseConfigured ? (
        <p className="rounded-lg border border-warning/20 bg-warning/10 p-3 text-sm font-bold text-warning">{t("admin.firebase_required")}</p>
      ) : null}

      {status ? <p className="rounded-lg border border-info/20 bg-info/10 p-3 text-sm font-bold text-info">{status}</p> : null}

      <section className="grid gap-4 sm:grid-cols-3">
        <StatCard label={t("admin.users_loaded")} value={users.length} helper={t("admin.search_results")} tone="bg-surface" />
        <StatCard label={t("admin.forge_subjects")} value={forgeContent.length} helper={t("admin.across_all_users")} tone="bg-info/10" />
        <StatCard
          label={t("admin.top_score")}
          value={overview?.topUsers?.[0]?.totalScore?.toLocaleString() || "-"}
          helper={t("admin.leaderboard_leader")}
          tone="bg-warning/10"
        />
      </section>

      <section className="grid gap-6 lg:grid-cols-[1fr_1fr]">
        <article className="rounded-xl border border-border bg-surface p-5 shadow-sm">
          <div className="mb-4 flex items-center gap-3">
            <Users className="text-primary" />
            <div>
              <p className="text-sm font-bold uppercase tracking-widest text-text-secondary">{t("admin.user_management")}</p>
              <h2 className="text-2xl font-black">{t("admin.search_users")}</h2>
            </div>
          </div>

          <div className="flex gap-2">
            <input
              value={searchTerm}
              onChange={(event) => setSearchTerm(event.target.value)}
              placeholder={t("admin.search_placeholder")}
              className="min-w-0 flex-1 rounded-lg border border-border px-3 py-2 text-sm outline-none transition-all focus:border-primary focus:ring-1 focus:ring-primary/50"
            />
            <button
              type="button"
              disabled={busy}
              onClick={runSearch}
              className="inline-flex items-center gap-2 rounded-lg bg-secondary px-4 py-2 text-sm font-black text-white disabled:bg-text-muted"
            >
              <Search size={16} />
              {t("common.search")}
            </button>
          </div>

          <div className="mt-4 max-h-72 overflow-auto rounded-lg border border-border">
            {users.length ? (
              users.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => {
                    setSelectedUserId(item.id);
                    setTotalScoreInput(String(item.totalScore || calculateTotalScore(item)));
                  }}
                  className={`flex w-full items-center justify-between gap-3 border-b border-border/50 px-3 py-3 text-left last:border-b-0 ${
                    selectedUserId === item.id ? "bg-primary/10" : "bg-surface"
                  }`}
                >
                  <span>
                    <span className="block font-black">{item.name || t("admin.unnamed")}</span>
                    <span className="block text-xs text-text-secondary">{item.email}</span>
                  </span>
                  <span className="text-right text-xs font-bold text-text-secondary">
                    {t("leaderboard.xp")} {item.xp || 0}
                    <br />
                    {t("dashboard.energy")} {item.energy || 0}
                  </span>
                </button>
              ))
            ) : (
              <EmptyState title={t("admin.no_users")} copy={t("admin.no_users_desc")} />
            )}
          </div>
        </article>

        <article className="rounded-xl border border-border bg-surface p-5 shadow-sm">
          <div className="mb-4 flex items-center gap-3">
            <Zap className="text-warning" />
            <div>
              <p className="text-sm font-bold uppercase tracking-widest text-text-secondary">{t("admin.rewards_progress")}</p>
              <h2 className="text-2xl font-black">{t("admin.adjust_xp")}</h2>
            </div>
          </div>

          {selectedUser ? (
            <p className="mb-4 rounded-lg bg-background p-3 text-sm">
              <strong>{selectedUser.name}</strong> - {t("leaderboard.xp")} {selectedUser.xp || 0}, {t("dashboard.energy")} {selectedUser.energy || 0},
              {t("admin.total")} {selectedUser.totalScore || calculateTotalScore(selectedUser)}
            </p>
          ) : (
            <p className="mb-4 text-sm text-text-secondary">{t("admin.select_user")}</p>
          )}

          <div className="grid gap-4">
            <div className="rounded-lg border border-border p-3">
              <p className="text-sm font-black">{t("leaderboard.xp")}</p>
              <div className="mt-2 flex items-center gap-2">
                <input
                  type="number"
                  value={xpDelta}
                  onChange={(event) => setXpDelta(event.target.value)}
                  className="w-24 rounded-lg border border-border px-3 py-2 text-sm outline-none transition-all focus:border-primary focus:ring-1 focus:ring-primary/50"
                />
                <button type="button" disabled={busy} onClick={() => runXpAdjust(1)} className="rounded-lg bg-primary px-3 py-2 text-sm font-black text-white">
                  {t("admin.add_xp")}
                </button>
                <button type="button" disabled={busy} onClick={() => runXpAdjust(-1)} className="rounded-lg border border-border px-3 py-2 text-sm font-bold">
                  {t("admin.remove_xp")}
                </button>
              </div>
            </div>

            <div className="rounded-lg border border-border p-3">
              <p className="text-sm font-black">{t("dashboard.energy")}</p>
              <div className="mt-2 flex items-center gap-2">
                <input
                  type="number"
                  value={energyDelta}
                  onChange={(event) => setEnergyDelta(event.target.value)}
                  className="w-24 rounded-lg border border-border px-3 py-2 text-sm outline-none transition-all focus:border-primary focus:ring-1 focus:ring-primary/50"
                />
                <button type="button" disabled={busy} onClick={() => runEnergyAdjust(1)} className="rounded-lg bg-warning px-3 py-2 text-sm font-black text-white">
                  {t("admin.add_energy")}
                </button>
                <button type="button" disabled={busy} onClick={() => runEnergyAdjust(-1)} className="rounded-lg border border-border px-3 py-2 text-sm font-bold">
                  {t("admin.remove_energy")}
                </button>
              </div>
            </div>

            <div className="rounded-lg border border-border p-3">
              <p className="text-sm font-black">{t("admin.total_score_override")}</p>
              <div className="mt-2 flex items-center gap-2">
                <input
                  type="number"
                  value={totalScoreInput}
                  onChange={(event) => setTotalScoreInput(event.target.value)}
                  className="w-32 rounded-lg border border-border px-3 py-2 text-sm outline-none transition-all focus:border-primary focus:ring-1 focus:ring-primary/50"
                />
                <button type="button" disabled={busy} onClick={runTotalScoreSet} className="rounded-lg bg-secondary px-3 py-2 text-sm font-black text-white">
                  {t("admin.set_total_score")}
                </button>
              </div>
            </div>
          </div>
        </article>
      </section>

      <section className="grid gap-6 lg:grid-cols-[1fr_1fr]">
        <article className="rounded-xl border border-border bg-surface p-5 shadow-sm">
          <div className="mb-4 flex items-center gap-3">
            <Trophy className="text-primary" />
            <div>
              <p className="text-sm font-bold uppercase tracking-widest text-text-secondary">{t("leaderboard.title")}</p>
              <h2 className="text-2xl font-black">{t("admin.reward_events")}</h2>
            </div>
          </div>

          <div className="grid gap-3">
            <input
              type="number"
              value={rewardXp}
              onChange={(event) => setRewardXp(event.target.value)}
              className="rounded-lg border border-border px-3 py-2 text-sm outline-none transition-all focus:border-primary focus:ring-1 focus:ring-primary/50"
              placeholder={t("admin.xp_to_grant")}
            />
            <input
              type="number"
              value={rewardEnergy}
              onChange={(event) => setRewardEnergy(event.target.value)}
              className="rounded-lg border border-border px-3 py-2 text-sm outline-none transition-all focus:border-primary focus:ring-1 focus:ring-primary/50"
              placeholder={t("admin.energy_to_grant")}
            />
            <input
              value={rewardReason}
              onChange={(event) => setRewardReason(event.target.value)}
              className="rounded-lg border border-border px-3 py-2 text-sm outline-none transition-all focus:border-primary focus:ring-1 focus:ring-primary/50"
              placeholder={t("admin.reason")}
            />
            <button
              type="button"
              disabled={busy}
              onClick={runRewardEvent}
              className="inline-flex items-center justify-center gap-2 rounded-lg bg-gradient-to-r from-primary to-warning px-4 py-3 font-black text-white disabled:opacity-50"
            >
              <Award size={18} />
              {t("admin.grant_reward_event")}
            </button>
          </div>

          {overview?.topUsers?.length ? (
            <div className="mt-5">
              <p className="text-sm font-bold uppercase tracking-widest text-text-secondary">{t("admin.top_leaderboard")}</p>
              <div className="mt-2 grid gap-2">
                {overview.topUsers.slice(0, 5).map((entry) => (
                  <div key={entry.id} className="flex items-center justify-between rounded-lg border border-border px-3 py-2 text-sm">
                    <span className="font-black">
                      #{entry.rank} {entry.name}
                    </span>
                    <span className="font-bold text-primary">{entry.totalScore?.toLocaleString()}</span>
                  </div>
                ))}
              </div>
            </div>
          ) : null}
        </article>

        <article className="rounded-xl border border-border bg-surface p-5 shadow-sm">
          <div className="mb-4 flex items-center gap-3">
            <BookOpen className="text-warning" />
            <div>
              <p className="text-sm font-bold uppercase tracking-widest text-text-secondary">{t("admin.content")}</p>
              <h2 className="text-2xl font-black">{t("admin.forge_moderation")}</h2>
            </div>
          </div>

          <div className="max-h-96 overflow-auto rounded-lg border border-border">
            {forgeContent.length ? (
              forgeContent.map((entry) => (
                <div key={`${entry.userId}-${entry.subject.id}`} className="border-b border-border/50 px-3 py-3 last:border-b-0">
                  <p className="font-black">{entry.subject.title}</p>
                  <p className="text-xs text-text-secondary">
                    {entry.userName} &bull; {entry.userEmail}
                  </p>
                  <p className="mt-1 text-sm text-text-secondary">
                    {entry.subject.units?.length || 0} {t("admin.units")} &bull;{" "}
                    {entry.subject.units?.reduce((acc, unit) => acc + (unit.subUnits?.length || 0), 0) || 0} {t("admin.sub_units")}
                  </p>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => removeForgeSubject(entry.userId, entry.subject.id)}
                    className="mt-2 rounded-lg border border-error/20 px-3 py-1 text-xs font-bold text-error"
                  >
                    {t("admin.remove_subject")}
                  </button>
                </div>
              ))
            ) : (
              <EmptyState title={t("admin.no_forge_content")} copy={t("admin.no_forge_content_desc")} />
            )}
          </div>
        </article>
      </section>
    </div>
  );
}
