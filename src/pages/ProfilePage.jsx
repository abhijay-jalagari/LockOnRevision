import React, { useEffect, useState, useRef } from 'react';
import { useAuth } from '../context/AuthContext';
import { 
  Trophy, 
  Zap, 
  BookOpen, 
  Target, 
  CheckCircle, 
  Award, 
  Share2, 
  Edit3,
  Flame,
  GraduationCap,
  BookText,
  Battery,
  TrendingUp,
  Medal,
  Hammer,
  Calendar,
  Mail,
  Shield,
  Settings,
  KeyRound,
  ExternalLink,
  X
} from 'lucide-react';
import { Link } from 'react-router-dom';
import { 
  updateUserProfile, 
  calculateLevel, 
  getRank, 
  getBadge,
} from '../services/userService';
import { getLeaderboardUsers } from '../services/leaderboardService';
import { subscribeSubjects } from '../services/learningService';
import { subscribeForgeSubjects } from '../services/forgeService';
import { subscribeTimetables } from '../services/timetableService';
import { StatsCard } from '../components/Profile/StatsCard';
import { ActivityHeatmap } from '../components/Profile/ActivityHeatmap';
import { AchievementBadge } from '../components/Profile/AchievementBadge';
import { EditProfileModal } from '../components/Profile/EditProfileModal';
import { ProfileIconRenderer } from '../components/Profile/ProfileIconPicker';
import { getLeaderAvatar } from '../utils/avatar';
import { PasswordInput } from '../components/PasswordInput';
import { useTranslation } from 'react-i18next';

export function ProfilePage() {
  const { t } = useTranslation();
  const { profile, user, changePassword } = useAuth();
  const [isEditing, setIsEditing] = useState(false);
  const [saveStatus, setSaveStatus] = useState("");
  const saveTimeoutRef = useRef(null);
  const [showChangePw, setShowChangePw] = useState(false);
  const [newPassword, setNewPassword] = useState("");
  const [pwError, setPwError] = useState("");
  const [pwSuccess, setPwSuccess] = useState("");
  const [pwBusy, setPwBusy] = useState(false);

  // Live data subscriptions
  const [subjects, setSubjects] = useState([]);
  const [forgeSubjects, setForgeSubjects] = useState([]);
  const [timetables, setTimetables] = useState([]);
  const [leaderboardPos, setLeaderboardPos] = useState(null);
  const [subsReady, setSubsReady] = useState({ subjects: false, forge: false, timetables: false });

  // Leaderboard position - re-fetches when XP/score changes
  useEffect(() => {
    if (!user?.uid) return;
    let cancelled = false;
    getLeaderboardUsers({ pageSize: 1000, page: 1 }).then((result) => {
      if (cancelled) return;
      const found = result.items.find((u) => u.id === user.uid);
      setLeaderboardPos(found ? found._rank : null);
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [user?.uid, profile?.xp, profile?.energy, profile?.totalScore]);

  // Real-time subscriptions
  useEffect(() => {
    if (!user?.uid) return;
    const unsubs = [
      subscribeSubjects(user.uid, (data) => { setSubjects(data); setSubsReady((s) => ({ ...s, subjects: true })); }),
      subscribeForgeSubjects(user.uid, (data) => { setForgeSubjects(data); setSubsReady((s) => ({ ...s, forge: true })); }),
      subscribeTimetables(user.uid, (data) => { setTimetables(data); setSubsReady((s) => ({ ...s, timetables: true })); }),
    ];
    return () => unsubs.forEach((fn) => fn?.());
  }, [user?.uid]);

  // Cleanup save timeout on unmount
  useEffect(() => {
    return () => {
      if (saveTimeoutRef.current) window.clearTimeout(saveTimeoutRef.current);
    };
  }, []);

  if (!profile) {
    return (
      <div className="min-h-[60vh] flex items-center justify-center">
        <div className="flex flex-col items-center gap-4">
          <div className="h-10 w-10 animate-spin rounded-full border-4 border-primary/20 border-t-primary" />
          <p className="text-lg font-bold text-text-secondary">{t("common.loading")}</p>
        </div>
      </div>
    );
  }

  const level = calculateLevel(profile.xp || 0);
  const rank = getRank(level);
  const badges = getBadge(profile.xp || 0, profile.completedLessons || 0, profile.streak || 0);
  
  // Derived statistics
  const totalLessons = profile.completedLessons || 0;
  const totalExercises = profile.completedTests?.length || 0;
  const studyHours = (profile.totalStudyHours || 0).toFixed(1);

  // Forge progress
  const forgeLessonCount = forgeSubjects.reduce((sum, fs) => {
    return sum + (fs.units || []).reduce((uSum, u) => {
      return uSum + (u.subUnits || []).reduce((sSum, su) => {
        return sSum + (su.lessons || []).length;
      }, 0);
    }, 0);
  }, 0);
  const forgeCompletedCount = forgeSubjects.reduce((sum, fs) => {
    return sum + (fs.units || []).reduce((uSum, u) => {
      return uSum + (u.subUnits || []).reduce((sSum, su) => {
        return sSum + (su.lessons || []).filter((l) => l.completed).length;
      }, 0);
    }, 0);
  }, 0);

  // Active timetable
  const activeTimetable = timetables[0];

  const handleSaveProfile = async (updates) => {
    if (saveTimeoutRef.current) window.clearTimeout(saveTimeoutRef.current);
    setSaveStatus("saving");
    try {
      await updateUserProfile(user.uid, updates);
      setSaveStatus("saved");
      saveTimeoutRef.current = window.setTimeout(() => setSaveStatus(""), 2000);
    } catch (error) {
      console.error("Error saving profile:", error);
      setSaveStatus("error");
      saveTimeoutRef.current = window.setTimeout(() => setSaveStatus(""), 3000);
      throw error;
    }
  };

  async function handleChangePassword(e) {
    e.preventDefault();
    setPwError("");
    setPwSuccess("");
    if (newPassword.length < 8) { setPwError(t("profile.password_min_chars")); return; }
    setPwBusy(true);
    try {
      await changePassword(newPassword);
      setPwSuccess(t("profile.password_changed"));
      setNewPassword("");
    } catch (err) {
      setPwError(err.message);
    } finally {
      setPwBusy(false);
    }
  }

  const shareProfile = () => {
    const url = `${window.location.origin}/profile`;
    navigator.clipboard.writeText(url);
    window.alert(t("profile.link_copied"));
  };

  const joinedDate = profile.createdAt?.toDate
    ? profile.createdAt.toDate().toLocaleDateString('en-GB', { year: 'numeric', month: 'long', day: 'numeric' })
    : null;

  return (
    <div className="max-w-6xl mx-auto p-4 md:p-8 space-y-8">
      {/* Save status toast */}
      {saveStatus && (
        <div className={`fixed top-4 right-4 z-50 px-4 py-3 rounded-xl border shadow-lg text-sm font-bold transition-all animate-fadeIn ${
          saveStatus === "saving" ? "text-primary border-primary/30" :
          saveStatus === "saved" ? "text-success border-success/30" :
          "text-error border-error/30"
        }`}
          style={{
            backgroundColor: saveStatus === "saving"
              ? "rgba(13, 141, 166, 0.1)"
              : saveStatus === "saved"
              ? "rgba(16, 185, 129, 0.1)"
              : "rgba(239, 68, 68, 0.1)"
          }}
        >
          {saveStatus === "saving" ? t("common.saving") : saveStatus === "saved" ? t("common.saved") : t("common.error_saving")}
        </div>
      )}

      {/* Header Section */}
      <div className="relative rounded-3xl border border-border bg-surface overflow-hidden shadow-sm">
        <div className="h-32 bg-gradient-to-r from-primary to-secondary" />
        <div className="px-8 pb-8">
          <div className="relative flex flex-col md:flex-row items-end gap-6 -mt-12">
            <div className="relative">
              {(() => {
                const av = getLeaderAvatar(profile, user?.uid);
                if (av.type === "image") {
                  return (
                    <img
                      src={av.src}
                      alt="Avatar"
                      className="w-32 h-32 rounded-3xl border-4 border-surface bg-background object-cover shadow-xl"
                    />
                  );
                }
                if (av.type === "icon") {
                  return (
                    <div className="w-32 h-32 rounded-3xl border-4 border-surface bg-background shadow-xl overflow-hidden p-3">
                      <ProfileIconRenderer iconId={av.iconId} className="w-full h-full" />
                    </div>
                  );
                }
                return (
                  <div
                    className="w-32 h-32 rounded-3xl border-4 border-surface bg-background shadow-xl overflow-hidden p-4"
                    dangerouslySetInnerHTML={{ __html: av.svg }}
                  />
                );
              })()}
              <button 
                onClick={() => setIsEditing(true)}
                className="absolute bottom-2 right-2 p-2 rounded-full bg-surface text-primary shadow-lg hover:scale-110 transition-transform border border-border"
              >
                <Edit3 size={16} />
              </button>
            </div>
            <div className="flex-1 mb-2 text-center md:text-left">
              <h1 className="text-4xl font-black text-text-primary tracking-tight">
                {profile.name || profile.email?.split('@')[0] || t("common.learner")}
              </h1>
              <p className="text-text-secondary font-medium">
                @{profile.username || 'learner'} • {t("profile.join_date")} {joinedDate || t("profile.recently")}
              </p>
            </div>
            <div className="flex gap-3 mb-2">
              <button 
                onClick={shareProfile}
                className="flex items-center gap-2 px-4 py-2 rounded-xl bg-surface text-text-primary font-bold border border-border hover:bg-background transition-colors shadow-sm"
              >
                <Share2 size={18} />
                {t("profile.share")}
              </button>
            </div>
          </div>
          <div className="mt-6 max-w-2xl">
            <p className="text-text-secondary leading-relaxed text-lg">
              {profile.bio || t("profile.no_bio")}
            </p>
          </div>
          {/* Grade & Curriculum */}
          {(profile.grade || profile.curriculum) && (
            <div className="mt-4 flex flex-wrap gap-3">
              {profile.grade && (
                <span className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-background text-xs font-bold text-text-secondary border border-border">
                  <GraduationCap size={14} />
                  {profile.grade}
                </span>
              )}
              {profile.curriculum && (
                <span className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-background text-xs font-bold text-text-secondary border border-border">
                  <BookText size={14} />
                  {profile.curriculum}
                </span>
              )}
            </div>
          )}
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
        {/* Left Column: Stats & Progress */}
        <div className="lg:col-span-2 space-y-8">
          {/* Top Stats Grid */}
          <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
            <StatsCard 
              label={t("Leaderboard Level")} 
              value={level} 
              icon={Trophy} 
              color="purple" 
            />
            <StatsCard 
              label={t("Rank")} 
              value={rank} 
              icon={Award} 
              color="orange" 
            />
            <StatsCard 
              label={t("dashboard.streak")} 
              value={`${profile.streak || 0}d`} 
              icon={Flame} 
              color="red" 
            />
            <StatsCard 
              label={t("dashboard.total_xp")} 
              value={profile.xp || 0} 
              icon={Zap} 
              color="blue" 
            />
            <StatsCard 
              label={t("dashboard.energy")} 
              value={profile.energy || 0} 
              icon={Battery} 
              color="green" 
            />
            <StatsCard 
              label={t("profile.total_score")} 
              value={(profile.totalScore || 0).toLocaleString()} 
              icon={TrendingUp} 
              color="slate" 
            />
          </div>

          {/* Leaderboard Position + Achievement Count inline */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div className="p-5 rounded-2xl border border-border bg-surface shadow-sm hover:shadow-md hover:-translate-y-0.5 transition-all duration-200">
              <div className="flex items-center gap-3 mb-2">
                <Medal size={20} className="text-warning shrink-0" />
                <span className="text-xs font-bold uppercase tracking-widest text-text-muted">{t("nav.leaderboard")}</span>
              </div>
              {leaderboardPos !== null ? (
                <Link to="/leaderboard" className="group inline-flex items-center gap-2">
                  <span className="text-3xl font-black text-text-primary tracking-tighter">#{leaderboardPos}</span>
                  <ExternalLink size={16} className="text-text-muted group-hover:text-primary transition-colors" />
                </Link>
              ) : (
                <span className="text-3xl font-black text-text-muted tracking-tighter">--</span>
              )}
            </div>
            <div className="p-5 rounded-2xl border border-border bg-surface shadow-sm hover:shadow-md hover:-translate-y-0.5 transition-all duration-200">
              <div className="flex items-center gap-3 mb-2">
                <Award size={20} className="text-warning shrink-0" />
                <span className="text-xs font-bold uppercase tracking-widest text-text-muted">{t("profile.achievements")}</span>
              </div>
              <span className="text-3xl font-black text-text-primary tracking-tighter">
                {badges.length} / 4
              </span>
            </div>
          </div>

          {/* Learning Progress & Goals */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            <div className="p-6 rounded-3xl border border-border bg-surface space-y-4 shadow-sm">
              <h3 className="text-lg font-black flex items-center gap-2 text-text-primary">
                <BookOpen size={20} className="text-primary" />
                {t("profile.learning_progress")}
              </h3>
              <div className="space-y-3">
                <div className="flex justify-between items-center p-3 rounded-xl bg-background border border-border">
                  <span className="text-sm font-medium text-text-secondary">{t("profile.lessons_completed")}</span>
                  <span className="font-black text-text-primary">{totalLessons}</span>
                </div>
                <div className="flex justify-between items-center p-3 rounded-xl bg-background border border-border">
                  <span className="text-sm font-medium text-text-secondary">{t("profile.exercises_solved")}</span>
                  <span className="font-black text-text-primary">{totalExercises}</span>
                </div>
                <div className="flex justify-between items-center p-3 rounded-xl bg-background border border-border">
                  <span className="text-sm font-medium text-text-secondary">{t("profile.units_completed")}</span>
                  <span className="font-black text-text-primary">{profile.completedUnits?.length || 0}</span>
                </div>
                <div className="flex justify-between items-center p-3 rounded-xl bg-background border border-border">
                  <span className="text-sm font-medium text-text-secondary">{t("profile.study_time")}</span>
                  <span className="font-black text-text-primary">{studyHours}h</span>
                </div>
              </div>
            </div>
            <div className="p-6 rounded-3xl border border-border bg-surface space-y-4 shadow-sm">
              <h3 className="text-lg font-black flex items-center gap-2 text-text-primary">
                <Target size={20} className="text-primary" />
                {t("profile.current_goals")}
              </h3>
              <div className="space-y-3">
                {profile.goals ? (
                <p className="text-sm text-text-secondary leading-relaxed italic p-4 bg-background rounded-xl border border-border">
                  &quot;{profile.goals}&quot;
                </p>
                ) : (
                  <p className="text-sm text-text-muted italic p-4 bg-background rounded-xl border border-border">{t("profile.no_goals")}</p>
                )}
                <button 
                  onClick={() => setIsEditing(true)}
                  className="text-xs font-bold text-primary hover:text-secondary transition-colors"
                >
                  {t("profile.edit_goals")} &rarr;
                </button>
              </div>
            </div>
          </div>

          {/* Current Subjects */}
          {!subsReady.subjects ? (
            <div className="p-6 rounded-3xl border border-border bg-surface space-y-4 shadow-sm">
              <h3 className="text-lg font-black flex items-center gap-2 text-text-primary">
                <BookOpen size={20} className="text-primary" />
                {t("profile.current_subjects")}
              </h3>
              <div className="flex items-center justify-center py-8">
                <div className="h-6 w-6 animate-spin rounded-full border-2 border-primary/20 border-t-primary" />
              </div>
            </div>
          ) : subjects.length > 0 ? (
            <div className="p-6 rounded-3xl border border-border bg-surface space-y-4 shadow-sm">
              <h3 className="text-lg font-black flex items-center gap-2 text-text-primary">
                <BookOpen size={20} className="text-primary" />
                {t("profile.current_subjects")}
              </h3>
              <div className="space-y-3">
                {subjects.slice(0, 5).map((subject) => {
                  const subjectLessons = forgeSubjects
                    .flatMap((fs) => fs.units || [])
                    .flatMap((u) => u.subUnits || [])
                    .flatMap((su) => su.lessons || [])
                    .filter((l) => l.subjectId === subject.id || l.subjectName === subject.title);
                  const completed = subjectLessons.filter((l) => l.completed).length;
                  const total = subjectLessons.length;
                  const progress = total > 0 ? Math.round((completed / total) * 100) : 0;
                  return (
                    <div key={subject.id} className="flex items-center justify-between p-3 rounded-xl bg-background border border-border">
                      <div className="min-w-0 flex-1">
                        <p className="text-sm font-bold text-text-primary truncate">{subject.title}</p>
                        <p className="text-xs text-text-muted">{t("profile.lessons_count", { completed, total })}</p>
                      </div>
                      <div className="flex items-center gap-3">
                        <div className="w-20 h-2 rounded-full bg-border overflow-hidden">
                          <div className="h-full bg-primary rounded-full transition-all" style={{ width: `${progress}%` }} />
                        </div>
                        <span className="text-xs font-bold text-text-secondary w-8 text-right">{progress}%</span>
                      </div>
                    </div>
                  );
                })}
              </div>
              <Link to="/forge" className="text-xs font-bold text-primary hover:text-secondary transition-colors inline-flex items-center gap-1">
                {t("profile.view_all_subjects")} <ExternalLink size={12} />
              </Link>
            </div>
          ) : null}

          {/* Forge Progress */}
          {!subsReady.forge ? (
            <div className="p-6 rounded-3xl border border-border bg-surface space-y-4 shadow-sm">
              <h3 className="text-lg font-black flex items-center gap-2 text-text-primary">
                <Hammer size={20} className="text-primary" />
                {t("profile.forge_progress")}
              </h3>
              <div className="flex items-center justify-center py-8">
                <div className="h-6 w-6 animate-spin rounded-full border-2 border-primary/20 border-t-primary" />
              </div>
            </div>
          ) : forgeSubjects.length > 0 ? (
            <div className="p-6 rounded-3xl border border-border bg-surface space-y-4 shadow-sm">
              <h3 className="text-lg font-black flex items-center gap-2 text-text-primary">
                <Hammer size={20} className="text-primary" />
                {t("profile.forge_progress")}
              </h3>
              <div className="grid grid-cols-2 gap-4">
                <div className="p-4 rounded-xl bg-background border border-border text-center">
                  <p className="text-2xl font-black text-text-primary">{forgeSubjects.length}</p>
                  <p className="text-xs font-bold text-text-muted uppercase tracking-widest mt-1">{t("dashboard.subjects")}</p>
                </div>
                <div className="p-4 rounded-xl bg-background border border-border text-center">
                  <p className="text-2xl font-black text-text-primary">{forgeLessonCount}</p>
                  <p className="text-xs font-bold text-text-muted uppercase tracking-widest mt-1">{t("profile.lessons_label")}</p>
                </div>
                <div className="p-4 rounded-xl bg-background border border-border text-center">
                  <p className="text-2xl font-black text-text-primary">{forgeCompletedCount}</p>
                  <p className="text-xs font-bold text-text-muted uppercase tracking-widest mt-1">{t("profile.completed_label")}</p>
                </div>
                <div className="p-4 rounded-xl bg-background border border-border text-center">
                  <p className="text-2xl font-black text-text-primary">
                    {forgeLessonCount > 0 ? Math.round((forgeCompletedCount / forgeLessonCount) * 100) : 0}%
                  </p>
                  <p className="text-xs font-bold text-text-muted uppercase tracking-widest mt-1">{t("profile.progress_label")}</p>
                </div>
              </div>
              <Link to="/forge" className="text-xs font-bold text-primary hover:text-secondary transition-colors inline-flex items-center gap-1">
                {t("profile.open_forge")} <ExternalLink size={12} />
              </Link>
            </div>
          ) : null}

          {/* Active Timetable */}
          {!subsReady.timetables ? (
            <div className="p-6 rounded-3xl border border-border bg-surface space-y-4 shadow-sm">
              <h3 className="text-lg font-black flex items-center gap-2 text-text-primary">
                <Calendar size={20} className="text-primary" />
                {t("profile.active_timetable")}
              </h3>
              <div className="flex items-center justify-center py-8">
                <div className="h-6 w-6 animate-spin rounded-full border-2 border-primary/20 border-t-primary" />
              </div>
            </div>
          ) : activeTimetable ? (
            <div className="p-6 rounded-3xl border border-border bg-surface space-y-4 shadow-sm">
              <h3 className="text-lg font-black flex items-center gap-2 text-text-primary">
                <Calendar size={20} className="text-primary" />
                {t("profile.active_timetable")}
              </h3>
              <div className="grid grid-cols-2 gap-4">
                <div className="p-4 rounded-xl bg-background border border-border text-center">
                  <p className="text-2xl font-black text-text-primary">{activeTimetable.weeks?.length || 0}</p>
                  <p className="text-xs font-bold text-text-muted uppercase tracking-widest mt-1">{t("profile.weeks")}</p>
                </div>
                <div className="p-4 rounded-xl bg-background border border-border text-center">
                  <p className="text-2xl font-black text-text-primary">
                    {activeTimetable.preferences?.dailyMinutes || 0}m
                  </p>
                  <p className="text-xs font-bold text-text-muted uppercase tracking-widest mt-1">{t("profile.daily_target")}</p>
                </div>
              </div>
              <Link to="/timetable" className="text-xs font-bold text-primary hover:text-secondary transition-colors inline-flex items-center gap-1">
                {t("profile.view_timetable")} <ExternalLink size={12} />
              </Link>
            </div>
          ) : null}

          {/* Activity Heatmap */}
          <ActivityHeatmap activity={profile.activity} />
        </div>

        {/* Right Column: Badges, Subjects & Account */}
        <div className="space-y-8">
          {/* Achievements */}
          <div className="p-6 rounded-3xl border border-border bg-surface shadow-sm">
             <h3 className="text-lg font-black mb-6 flex items-center gap-2 text-text-primary">
               <Award size={20} className="text-warning" />
               {t("profile.achievements")}
               <span className="ml-auto text-xs font-bold text-text-muted bg-background px-2 py-1 rounded-lg">{badges.length}/4</span>
             </h3>

            <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
              {badges.length > 0 ? (
                badges.map(badge => (
                  <AchievementBadge key={badge.id} badge={badge} />
                ))
              ) : (
                <p className="col-span-3 text-sm text-text-muted text-center py-4 italic">
                  {t("profile.earn_badges")}
                </p>
              )}
            </div>
          </div>

          {/* Favorite Subjects */}
          <div className="p-6 rounded-3xl border border-border bg-surface shadow-sm">
            <h3 className="text-lg font-black mb-6 flex items-center gap-2 text-text-primary">
              <CheckCircle size={20} className="text-success" />
              {t("profile.favorite_subjects")}
            </h3>
            <div className="flex flex-wrap gap-2">
              {profile.favoriteSubjects?.length > 0 ? (
                profile.favoriteSubjects.map((sub, i) => (
                  <span key={i} className="px-3 py-1 rounded-full bg-background text-text-primary text-xs font-bold border border-border transition-colors hover:border-primary">
                      {sub}
                  </span>
                ))
              ) : (
                <p className="text-sm text-text-muted italic">{t("profile.no_favorites")}</p>
              )}
            </div>
          </div>

          {/* Account Information */}
          <div className="p-6 rounded-3xl border border-border bg-surface shadow-sm">
            <h3 className="text-lg font-black mb-6 flex items-center gap-2 text-text-primary">
              <Settings size={20} className="text-primary" />
              {t("profile.account_information")}
            </h3>
            <div className="space-y-3">
              <div className="flex items-center gap-3 p-3 rounded-xl bg-background border border-border">
                <Mail size={16} className="text-text-muted shrink-0" />
                <div className="min-w-0">
                  <p className="text-xs font-bold text-text-muted uppercase tracking-widest">{t("auth.email")}</p>
                  <p className="text-sm font-bold text-text-primary truncate">{profile.email || user?.email || '—'}</p>
                </div>
                {user?.emailVerified ? (
                  <span className="shrink-0 text-xs font-bold text-success px-2 py-1 rounded-lg" style={{ backgroundColor: "rgba(16, 185, 129, 0.1)" }}>{t("profile.verified")}</span>
                ) : (
                  <span className="shrink-0 text-xs font-bold text-warning px-2 py-1 rounded-lg" style={{ backgroundColor: "rgba(245, 158, 11, 0.1)" }}>{t("profile.unverified")}</span>
                )}
              </div>
              <div className="flex items-center gap-3 p-3 rounded-xl bg-background border border-border">
                <Shield size={16} className="text-text-muted shrink-0" />
                <div className="min-w-0">
                  <p className="text-xs font-bold text-text-muted uppercase tracking-widest">{t("profile.role")}</p>
                  <p className="text-sm font-bold text-text-primary capitalize">{profile.isAdmin ? t("profile.admin_role") : t("profile.user_role")}</p>
                </div>
              </div>
              {joinedDate && (
                <div className="flex items-center gap-3 p-3 rounded-xl bg-background border border-border">
                  <Calendar size={16} className="text-text-muted shrink-0" />
                  <div className="min-w-0">
                    <p className="text-xs font-bold text-text-muted uppercase tracking-widest">{t("profile.member_since")}</p>
                    <p className="text-sm font-bold text-text-primary">{joinedDate}</p>
                  </div>
                </div>
              )}
              <button
                type="button"
                onClick={() => setShowChangePw(true)}
                className="w-full flex items-center justify-center gap-2 py-3 rounded-xl bg-background text-text-primary font-bold border border-border hover:bg-surface hover:border-primary transition-all text-sm"
              >
                <KeyRound size={16} />
                {t("profile.change_password")}
              </button>
            </div>
            <button
              type="button"
              onClick={() => setIsEditing(true)}
              className="mt-4 w-full py-3 rounded-xl bg-background text-text-primary font-bold border border-border hover:bg-surface hover:border-primary transition-all text-sm"
            >
              {t("profile.edit_profile")}
            </button>
          </div>
        </div>
      </div>

      {isEditing && (
        <EditProfileModal 
          profile={profile} 
          onClose={() => setIsEditing(false)} 
          onSave={handleSaveProfile}
        />
      )}

      {showChangePw && (
        <div className="fixed inset-0 z-50 grid place-items-center bg-black/40 px-4" onClick={() => setShowChangePw(false)}>
          <div className="w-full max-w-md rounded-3xl border border-border bg-surface p-8 shadow-2xl" onClick={(e) => e.stopPropagation()}>
            <div className="mb-6 flex items-center justify-between">
              <h2 className="text-xl font-black tracking-tight text-text-primary">{t("profile.change_password")}</h2>
              <button
                type="button"
                onClick={() => setShowChangePw(false)}
                className="rounded-xl border border-border bg-surface p-2 text-text-secondary transition-colors hover:bg-primary hover:text-white"
                aria-label={t("common.close")}
              >
                <X size={18} />
              </button>
            </div>
            <form onSubmit={handleChangePassword} className="grid gap-4">
              <label className="grid gap-2 text-sm font-bold text-text-primary">
                {t("profile.new_password")}
                <PasswordInput
                  id="change-password"
                  value={newPassword}
                  onChange={(e) => setNewPassword(e.target.value)}
                  showValidation={true}
                />
              </label>
              {pwSuccess ? (
                <p className="rounded-xl p-3 text-sm font-bold text-success" style={{ backgroundColor: "rgba(16, 185, 129, 0.2)" }}>{pwSuccess}</p>
              ) : null}
              {pwError ? (
                <p className="rounded-xl p-3 text-sm font-bold text-error" style={{ backgroundColor: "rgba(239, 68, 68, 0.2)" }}>{pwError}</p>
              ) : null}
              <button
                type="submit"
                disabled={pwBusy || newPassword.length < 8}
                className="rounded-xl bg-primary px-4 py-3 font-black text-white transition-all hover:bg-primary-active active:scale-95 disabled:opacity-50"
              >
                {pwBusy ? t("common.saving") : t("profile.update_password")}
              </button>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}