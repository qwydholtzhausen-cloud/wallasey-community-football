import { SeasonPitch, type SeasonGame } from "./celebrate";
import { useEffect, useState } from "react";
import { nowInLondon } from "../../lib/time";
import { EmptyScene } from "./EmptyScene";
import { useCredits } from "./credits";
import { creditLabel } from "../../lib/credits";
import {
  AccordionSection,
  Avatar,
  MAX_AWARD_VIDEO_MB,
  MAX_SPOTS,
  POSITIONS,
  POSITION_LABEL,
  ROLE_LABEL,
  SetIcon,
  StatusBadge,
  avatarFor,
  fmtDate,
  fmtDateTime,
  ratingFillColor,
  type PlayerPosition,
} from "./shared";
import type {
  AdminMessage,
  AuditLogEntry,
  AwardRow,
  BookingRow,
  ClubSettings,
  EmergencyContact,
  GameRow,
  PlayerBirthday,
  PlayerRating,
  Profile,
  Role,
} from "../WirralCommunityFootball";

export function AccountPanel({
  profile,
  email,
  isAdmin,
  isOwner,
  profiles,
  clubSettings,
  awards,
  onRename,
  onUploadAvatar,
  onRemoveAvatar,
  onAdminRemoveAvatar,
  onSetRole,
  onAdminRename,
  onDeleteProfile,
  onAddPlayer,
  onGenerateLoginCode,
  onSaveClubSettings,
  onAddAward,
  onDeleteAward,
  onSignOut,
  onEnablePush,
  onDisablePush,
  onSendTestPush,
  pushStats,
  auditLog,
  showAuditLog,
  onToggleAuditLog,
  myRating,
  onSaveSelfRating,
  adminRatings,
  onSaveAdminRating,
  myEmergencyContact,
  onSaveEmergencyContact,
  myBirthday,
  onSaveBirthday,
  ratingPlayerId,
  onToggleRatingPlayer,
  myRecord,
  mySeasonGames,
  seasonYear,
  myGoals,
  onOpenMyCard,
  myUpcomingBookings,
  myTabOwed,
  myTabPending,
  onMarkPaid,
  messages,
  onMarkMessageRead,
  onMarkAllRead,
  askConfirm,
  newMembers,
}: {
  newMembers?: React.ReactNode;
  profile: Profile;
  email: string;
  isAdmin: boolean;
  isOwner: boolean;
  profiles: Profile[];
  myRecord: { played: number; won: number; drawn: number; lost: number; winPct: number | null };
  mySeasonGames: SeasonGame[];
  seasonYear: string;
  myGoals: number;
  onOpenMyCard: () => void;
  myUpcomingBookings: { game: GameRow; booking: BookingRow }[];
  myTabOwed: { game: GameRow; booking: BookingRow }[];
  myTabPending: { game: GameRow; booking: BookingRow }[];
  onMarkPaid: (bookingId: string) => void;
  askConfirm: (title: string, message: string, confirmLabel?: string, danger?: boolean) => Promise<boolean>;
  auditLog: AuditLogEntry[];
  showAuditLog: boolean;
  onToggleAuditLog: () => void;
  myRating: PlayerRating | null;
  onSaveSelfRating: (fitness: number, attack: number, defence: number, goalkeeping: number, position: PlayerPosition) => void;
  adminRatings: PlayerRating[];
  onSaveAdminRating: (playerId: string, fitness: number, attack: number, defence: number, goalkeeping: number, position: PlayerPosition) => void;
  myEmergencyContact: EmergencyContact | null;
  onSaveEmergencyContact: (contactName: string, contactPhone: string) => void;
  myBirthday: PlayerBirthday | null;
  onSaveBirthday: (dateOfBirth: string) => void;
  ratingPlayerId: string | null;
  onToggleRatingPlayer: (id: string) => void;
  clubSettings: ClubSettings;
  pushStats: { total: number; subscribed: number } | null;
  awards: AwardRow[];
  onRename: (name: string) => void;
  onUploadAvatar: (file: File) => Promise<void>;
  onRemoveAvatar: () => Promise<void>;
  onAdminRemoveAvatar: (id: string) => Promise<void>;
  onSetRole: (id: string, role: Role) => void;
  onAdminRename: (id: string, name: string) => void;
  onDeleteProfile: (id: string, name: string) => void;
  onAddPlayer: (email: string, displayName: string) => Promise<boolean>;
  onGenerateLoginCode: (email: string) => Promise<string | null>;
  onSaveClubSettings: (patch: Partial<ClubSettings>) => void;
  onAddAward: (title: string, value: string, note: string, imageFile: File | null, videoFile: File | null) => Promise<void>;
  onDeleteAward: (id: string) => void;
  onSignOut: () => void;
  onEnablePush: () => Promise<boolean>;
  onDisablePush: () => Promise<void>;
  onSendTestPush: () => Promise<void>;
  messages: AdminMessage[];
  onMarkMessageRead: (id: string) => void;
  onMarkAllRead: () => void;
}) {
  const [name, setName] = useState(profile.display_name);
  const [contactName, setContactName] = useState(myEmergencyContact?.contact_name ?? "");
  const [contactPhone, setContactPhone] = useState(myEmergencyContact?.contact_phone ?? "");
  const [dobDraft, setDobDraft] = useState(myBirthday?.date_of_birth ?? "");
  const myMessages = messages.filter((m) => m.recipient_id === profile.id);
  const unreadMessages = myMessages.filter((m) => !m.read_at);
  const readMessages = myMessages.filter((m) => m.read_at);
  const [openReadMessages, setOpenReadMessages] = useState(false);
  const [showRoles, setShowRoles] = useState(false);
  const [roleSearch, setRoleSearch] = useState("");
  const [roleMenuFor, setRoleMenuFor] = useState<string | null>(null);
  const [openRoleTool, setOpenRoleTool] = useState<"add" | "code" | null>(null);
  const [renamingPlayerId, setRenamingPlayerId] = useState<string | null>(null);
  // Game credits: an admin adding one by hand, with an optional note.
  const credits = useCredits();
  const [creditFor, setCreditFor] = useState<string | null>(null);
  const [creditNote, setCreditNote] = useState("");
  const creditsOf = (playerId: string) => credits.all.filter((c) => c.player_id === playerId && c.status === "available").length;
  const [renameDraft, setRenameDraft] = useState("");
  const filteredRoleProfiles = profiles.filter((p) => p.display_name.toLowerCase().includes(roleSearch.trim().toLowerCase()));
  const [pushBusy, setPushBusy] = useState(false);
  // Settings rows are collapsed by default and only one is open at a time -
  // everything there is "set once, rarely touched again".
  const [openSetting, setOpenSetting] = useState<"name" | "contact" | "birthday" | "rating" | null>(null);
  const toggleSetting = (k: "name" | "contact" | "birthday" | "rating") => setOpenSetting((cur) => (cur === k ? null : k));
  // A player can have a dozen unread reminders; the newest two are what
  // matter, and each one shows two lines until tapped.
  const [showAllUnread, setShowAllUnread] = useState(false);
  const [openMessageIds, setOpenMessageIds] = useState<Set<string>>(() => new Set());
  // Regulars book weeks ahead, so the full list can run to 20; the next few
  // are what matter day to day.
  const [showAllBookings, setShowAllBookings] = useState(false);
  const BOOKINGS_SHOWN = 3;
  const nth = (n: number) => n + (["th", "st", "nd", "rd"][((n % 100) - 20) % 10] || ["th", "st", "nd", "rd"][n % 100] || "th");
  const [openClubSettings, setOpenClubSettings] = useState(false);
  const [openAwards, setOpenAwards] = useState(false);
  const [openGuide, setOpenGuide] = useState<"install" | "notifications" | null>(null);
  // push_opt_in is a shared per-user DB flag, but permission is granted
  // per-device/per-browser - deriving "on" from both means a fresh device
  // (or one where permission was never actually granted) correctly shows
  // "Off" instead of a stale "On" that doesn't reflect reality here.
  const pushGranted = typeof window !== "undefined" && "Notification" in window && Notification.permission === "granted";
  const pushOn = !!profile.push_opt_in && pushGranted;

  useEffect(() => setName(profile.display_name), [profile.display_name]);
  useEffect(() => {
    setContactName(myEmergencyContact?.contact_name ?? "");
    setContactPhone(myEmergencyContact?.contact_phone ?? "");
  }, [myEmergencyContact]);
  useEffect(() => setDobDraft(myBirthday?.date_of_birth ?? ""), [myBirthday]);

  // Automatic reminders are sent with no sender; anything an admin typed
  // carries their id, so it can say who it's from.
  const senderLabel = (m: AdminMessage) => (m.sender_id ? `From ${profiles.find((p) => p.id === m.sender_id)?.display_name ?? "an admin"}` : "From the club");
  const INBOX_SHOWN = 2;
  const inboxRow = (m: AdminMessage) => {
    const open = openMessageIds.has(m.id);
    return (
      <div key={m.id} className={"wcf-inbox-row" + (m.read_at ? "" : " unread") + (open ? " open" : "")}>
        <button
          className="wcf-inbox-row-head"
          aria-expanded={open}
          onClick={() =>
            setOpenMessageIds((cur) => {
              const next = new Set(cur);
              if (next.has(m.id)) next.delete(m.id);
              else next.add(m.id);
              return next;
            })
          }
        >
          <span className="wcf-inbox-row-dot" aria-hidden="true" />
          <span className="wcf-inbox-row-main">
            <span className="wcf-inbox-row-top">
              <span className="wcf-inbox-row-from">{senderLabel(m)}</span>
              <span className="wcf-inbox-row-when">{fmtDateTime(m.created_at)}</span>
            </span>
            <span className="wcf-inbox-row-body">{m.message}</span>
          </span>
        </button>
        {open && !m.read_at && (
          <button className="wcf-inbox-row-read" onClick={() => onMarkMessageRead(m.id)}>
            Mark as read
          </button>
        )}
      </div>
    );
  };

  // iPhones only allow notifications once the app is on the home screen, so
  // there "Turn on" shows the install guide first instead of failing.
  async function turnOnNotifications() {
    const ios = /iPad|iPhone|iPod/.test(navigator.userAgent);
    const standalone = window.matchMedia("(display-mode: standalone)").matches || (navigator as Navigator & { standalone?: boolean }).standalone === true;
    if (ios && !standalone) {
      setOpenGuide("install");
      return;
    }
    setPushBusy(true);
    await onEnablePush();
    setPushBusy(false);
  }

  const setValue = (done: boolean) => (done ? "Set ✓" : "Add");

  return (
    <div className="wcf-account">
      {/* Same family as the Player of the Month and "Your season" cards:
          your face and your record, tapping through to your player card. */}
      <div className="wcf-me">
        <div className="wcf-me-top">
          <div className="wcf-account-avatar-wrap">
            <Avatar name={profile.display_name} avatarUrl={profile.avatar_url} className="wcf-avatar wcf-me-avatar" />
            <label className="wcf-account-avatar-edit" aria-label="Change profile photo">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z" />
                <circle cx="12" cy="13" r="4" />
              </svg>
              <input
                type="file"
                accept="image/*"
                style={{ display: "none" }}
                onChange={async (e) => {
                  const file = e.target.files?.[0];
                  e.target.value = "";
                  if (file) await onUploadAvatar(file);
                }}
              />
            </label>
            {profile.avatar_url && (
              <button className="wcf-account-avatar-remove" onClick={() => onRemoveAvatar()} aria-label="Remove photo">
                ×
              </button>
            )}
          </div>
          <button className="wcf-me-who" onClick={onOpenMyCard}>
            <span className="wcf-me-name">{profile.display_name}</span>
            <span className={"wcf-role-badge small " + profile.role}>{ROLE_LABEL[profile.role]}</span>
          </button>
        </div>
        {myRecord.played > 0 ? (
          <button className="wcf-me-record" onClick={onOpenMyCard}>
            <span className="wcf-me-stats">
              <span>
                <b>{myRecord.played}</b>Played
              </span>
              <span>
                <b>{myRecord.won}</b>Won
              </span>
              <span>
                <b>{myGoals}</b>
                {myGoals === 1 ? "Goal" : "Goals"}
              </span>
              <span>
                <b>{myRecord.winPct}%</b>Win rate
              </span>
            </span>
            <span className="wcf-me-bar" aria-hidden="true">
              {myRecord.won > 0 && <i className="w" style={{ flex: myRecord.won }} />}
              {myRecord.drawn > 0 && <i className="d" style={{ flex: myRecord.drawn }} />}
              {myRecord.lost > 0 && <i className="l" style={{ flex: myRecord.lost }} />}
            </span>
            <span className="wcf-me-foot">
              <span>
                {myRecord.won}W · {myRecord.drawn}D · {myRecord.lost}L
              </span>
              <span className="wcf-me-link">View your player card ›</span>
            </span>
          </button>
        ) : (
          <p className="wcf-me-empty">Your record starts after your first game.</p>
        )}
      </div>
      {mySeasonGames.length > 0 && <SeasonPitch year={seasonYear} games={mySeasonGames} />}

      {myMessages.length > 0 && (
        <>
          <div className="wcf-console-section">
            <span className="wcf-console-section-label">Inbox</span>
            <span className="wcf-console-section-rule" />
            {unreadMessages.length > 0 && (
              <span className="wcf-inbox-unread-pill">
                <span className="wcf-inbox-unread-dot" />
                {unreadMessages.length} UNREAD
              </span>
            )}
            {unreadMessages.length > 1 && (
              <button className="wcf-inbox-allread" onClick={onMarkAllRead}>
                Mark all read
              </button>
            )}
          </div>
          {(showAllUnread ? unreadMessages : unreadMessages.slice(0, INBOX_SHOWN)).map(inboxRow)}
          {unreadMessages.length > INBOX_SHOWN && (
            <button className="wcf-rec-more" onClick={() => setShowAllUnread((v) => !v)}>
              {showAllUnread ? "Show fewer" : `${unreadMessages.length - INBOX_SHOWN} more unread`}
            </button>
          )}
          {unreadMessages.length === 0 && <EmptyScene kind="inbox" small title="All caught up" text="No new messages." />}
          {readMessages.length > 0 && (
            <button className="wcf-rec-more quiet" onClick={() => setOpenReadMessages((v) => !v)}>
              {openReadMessages ? "Hide read messages" : `Read messages (${readMessages.length})`}
            </button>
          )}
          {openReadMessages && readMessages.map(inboxRow)}
        </>
      )}

      {(myTabOwed.length > 0 || myTabPending.length > 0) &&
        (() => {
          const owedTotal = myTabOwed.reduce((sum, { game }) => sum + game.price, 0);
          return (
            <>
              <div className="wcf-console-section">
                <span className="wcf-console-section-label">Your tab</span>
                <span className="wcf-console-section-rule" />
                {owedTotal > 0 && <span className="wcf-console-section-meta warn">£{owedTotal} OWED</span>}
              </div>
              <div className="wcf-tab-hero">
                <div className="wcf-tab-hero-top">
                  <div>
                    <span className="wcf-tab-hero-amount">£{owedTotal}</span>
                    <span className="wcf-tab-hero-summary">
                      {myTabOwed.length > 0 && `${myTabOwed.length} game${myTabOwed.length === 1 ? "" : "s"} owed`}
                      {myTabOwed.length > 0 && myTabPending.length > 0 && " · "}
                      {myTabPending.length > 0 && `${myTabPending.length} awaiting confirmation`}
                    </span>
                  </div>
                  <span className="wcf-tab-hero-icon">£</span>
                </div>
                <div className="wcf-tab-hero-items">
                  {myTabOwed.map(({ game, booking }) => (
                    <div key={booking.id} className="wcf-tab-hero-item">
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div className="wcf-tab-hero-item-venue">{game.venue}</div>
                        <div className="wcf-tab-hero-item-date">{fmtDate(game.date)}</div>
                      </div>
                      <span className="wcf-tab-hero-item-price">£{game.price}</span>
                      <button className="wcf-tab-hero-pay" onClick={() => onMarkPaid(booking.id)}>
                        I&apos;ve paid
                      </button>
                    </div>
                  ))}
                  {myTabPending.map(({ game, booking }) => (
                    <div key={booking.id} className="wcf-tab-hero-item">
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div className="wcf-tab-hero-item-venue">{game.venue}</div>
                        <div className="wcf-tab-hero-item-date">{fmtDate(game.date)}</div>
                      </div>
                      <span className="wcf-tab-hero-item-price">£{game.price}</span>
                      <span className="wcf-tab-hero-claimed">AWAITING</span>
                    </div>
                  ))}
                </div>
                <p className="wcf-tab-hero-note">
                  {profile.payment_code ? (
                    <>
                      Bank transfer to the club account, reference <span className="wcf-tab-ref-code">{profile.payment_code}</span>. Payments with that
                      reference confirm automatically — no need to tell an admin.
                    </>
                  ) : (
                    "Bank transfer to the club account. An admin confirms it here once it lands."
                  )}
                </p>
              </div>
            </>
          );
        })()}

      {myUpcomingBookings.length > 0 && (
        <>
          <div className="wcf-console-section">
            <span className="wcf-console-section-label">Your bookings</span>
            <span className="wcf-console-section-rule" />
            <span className="wcf-console-section-meta">{myUpcomingBookings.length}</span>
          </div>
          {(showAllBookings ? myUpcomingBookings : myUpcomingBookings.slice(0, BOOKINGS_SHOWN)).map(({ game, booking }) => {
            const d = new Date(game.date + "T00:00:00");
            // Same queue order as the fixture card's "2nd in line".
            const queuePos = booking.waiting
              ? game.bookings
                  .filter((b) => b.waiting)
                  .sort((a, b) => a.created_at.localeCompare(b.created_at))
                  .findIndex((b) => b.id === booking.id) + 1
              : 0;
            return (
              <div key={game.id} className="wcf-booking-row">
                <div className="wcf-booking-date-tile">
                  <span className="wcf-booking-day">{d.getDate()}</span>
                  <span className="wcf-booking-month">{d.toLocaleDateString("en-GB", { month: "short" }).toUpperCase()}</span>
                </div>
                <div className="wcf-booking-info">
                  <div className="wcf-booking-venue">{game.venue}</div>
                  <div className="wcf-booking-meta">
                    {fmtDate(game.date)} · {game.kickoff}
                  </div>
                </div>
                {booking.waiting ? (
                  <span className="wcf-booking-badge amber">
                    {queuePos === 1 ? "NEXT IN LINE" : queuePos > 1 ? `${nth(queuePos).toUpperCase()} IN LINE` : "WAITING LIST"}
                  </span>
                ) : credits.byBooking.has(booking.id) ? (
                  // Paid with a game credit (fully, or £5 of a dearer game).
                  <span className={"wcf-status-badge " + booking.status}>{booking.status === "confirmed" ? "Paid with credit" : `Credit + £${game.price - (credits.byBooking.get(booking.id)?.value ?? 0)} to pay`}</span>
                ) : (
                  <StatusBadge status={booking.status} />
                )}
              </div>
            );
          })}
          {myUpcomingBookings.length > BOOKINGS_SHOWN && (
            <button className="wcf-rec-more" onClick={() => setShowAllBookings((v) => !v)}>
              {showAllBookings ? "Show fewer" : `Show all ${myUpcomingBookings.length} bookings`}
            </button>
          )}
        </>
      )}

      <div className="wcf-console-section">
        <span className="wcf-console-section-label">Settings</span>
        <span className="wcf-console-section-rule" />
      </div>

      {/* Out of the settings list on purpose: kickoff reminders, spot
          alerts and Wrapped all depend on it. */}
      <div className={"wcf-notif-card" + (pushOn ? " on" : "")}>
        <span className="wcf-notif-ic">
          <SetIcon name="bell" />
        </span>
        <div className="wcf-notif-text">
          <div className="wcf-notif-title">{pushOn ? "Notifications on" : "Notifications are off"}</div>
          <div className="wcf-notif-sub">
            {pushOn ? "Kickoff reminders, payment nudges, spots opening up" : "You'll miss kickoff reminders and spots opening up"}
          </div>
        </div>
        {pushOn ? (
          <button
            className="wcf-push-toggle on"
            disabled={pushBusy}
            aria-label="Turn off notifications"
            aria-pressed
            onClick={async () => {
              setPushBusy(true);
              await onDisablePush();
              setPushBusy(false);
            }}
          >
            <span className="wcf-push-toggle-knob" />
          </button>
        ) : (
          <button className="wcf-notif-on" disabled={pushBusy} onClick={turnOnNotifications}>
            Turn on
          </button>
        )}
      </div>
      {pushOn && (
        <button className="wcf-notif-test" onClick={onSendTestPush}>
          Send me a test notification
        </button>
      )}

      <div className="wcf-set-label">Your details</div>
      <div className="wcf-set-group">
        <AccordionSection
          icon={<SetIcon name="user" />}
          title="Display name"
          value={profile.display_name}
          open={openSetting === "name"}
          onToggle={() => toggleSetting("name")}
        >
          <label className="wcf-account-field">
            Display name
            <div className="wcf-account-rename">
              <input value={name} onChange={(e) => setName(e.target.value)} />
              <button
                onClick={async () => {
                  if (await askConfirm(`Change your display name?`, `Change it to "${name.trim()}"?`, "Save", false)) onRename(name);
                }}
                disabled={!name.trim() || name.trim() === profile.display_name}
              >
                Save
              </button>
            </div>
          </label>
        </AccordionSection>

        <AccordionSection
          icon={<SetIcon name="phone" />}
          title="Emergency contact"
          value={setValue(!!myEmergencyContact)}
          valueTone={myEmergencyContact ? "ok" : "add"}
          open={openSetting === "contact"}
          onToggle={() => toggleSetting("contact")}
        >
          <label className="wcf-account-field">
            Emergency contact
            <div className="wcf-account-emergency">
              <input placeholder="Contact name" value={contactName} onChange={(e) => setContactName(e.target.value)} />
              <input placeholder="Phone number" type="tel" value={contactPhone} onChange={(e) => setContactPhone(e.target.value)} />
              <button
                onClick={() => onSaveEmergencyContact(contactName.trim(), contactPhone.trim())}
                disabled={
                  !contactName.trim() ||
                  !contactPhone.trim() ||
                  (contactName.trim() === (myEmergencyContact?.contact_name ?? "") && contactPhone.trim() === (myEmergencyContact?.contact_phone ?? ""))
                }
              >
                Save
              </button>
            </div>
            <span className="wcf-push-sub">Who to call if something happens during a game. Only you and admins can see this.</span>
          </label>
        </AccordionSection>

        <AccordionSection
          icon={<SetIcon name="cake" />}
          title="Birthday"
          value={setValue(!!myBirthday)}
          valueTone={myBirthday ? "ok" : "add"}
          open={openSetting === "birthday"}
          onToggle={() => toggleSetting("birthday")}
        >
          <label className="wcf-account-field">
            Date of birth
            <div className="wcf-account-emergency">
              <input type="date" value={dobDraft} max={nowInLondon().slice(0, 10)} min="1920-01-01" onChange={(e) => setDobDraft(e.target.value)} />
              <button onClick={() => onSaveBirthday(dobDraft)} disabled={!dobDraft || dobDraft === (myBirthday?.date_of_birth ?? "")}>
                Save
              </button>
            </div>
            <span className="wcf-push-sub">
              Optional - only you and admins can see this. Lets GaffAI flag your birthday to the admins, and helps with squad planning.
            </span>
          </label>
        </AccordionSection>

        <AccordionSection
          icon={<SetIcon name="star" />}
          title="Rate yourself"
          meta="Helps admins pick fair teams"
          value={setValue(!!myRating)}
          valueTone={myRating ? "ok" : "add"}
          open={openSetting === "rating"}
          onToggle={() => toggleSetting("rating")}
        >
          <div className="wcf-rating-section">
            <p className="wcf-rating-note">Only visible to you and admins — once an admin rates you, theirs takes over.</p>
            <RatingForm initial={myRating} onSave={onSaveSelfRating} saveLabel={myRating ? "Update my rating" : "Save my rating"} />
          </div>
        </AccordionSection>
      </div>

      <div className="wcf-set-label">Help</div>
      <div className="wcf-set-group">
        <button className="wcf-set-link" onClick={() => setOpenGuide("install")}>
          <span className="wcf-acc-section-tile">
            <SetIcon name="mobile" />
          </span>
          <span className="wcf-set-link-title">Add to your home screen</span>
          <span className="wcf-set-chev" aria-hidden="true">
            ›
          </span>
        </button>
        <button className="wcf-set-link" onClick={() => setOpenGuide("notifications")}>
          <span className="wcf-acc-section-tile">
            <SetIcon name="bell" />
          </span>
          <span className="wcf-set-link-title">How to turn on notifications</span>
          <span className="wcf-set-chev" aria-hidden="true">
            ›
          </span>
        </button>
        <a className="wcf-set-link" href="/privacy">
          <span className="wcf-acc-section-tile">
            <SetIcon name="shield" />
          </span>
          <span className="wcf-set-link-title">Privacy</span>
          <span className="wcf-set-chev" aria-hidden="true">
            ›
          </span>
        </a>
        <div className="wcf-set-link static">
          <span className="wcf-acc-section-tile">
            <SetIcon name="mail" />
          </span>
          <span className="wcf-set-link-title">Signed in as</span>
          <span className="wcf-set-email">{email}</span>
        </div>
      </div>

      {openGuide && (
        <div className="wcf-lightbox" onClick={() => setOpenGuide(null)}>
          <button className="wcf-lightbox-close" onClick={() => setOpenGuide(null)} aria-label="Close">
            ×
          </button>
          <img
            className="wcf-lightbox-img"
            src={openGuide === "install" ? "/Install_Guide.png" : "/Notifications_Guide.png"}
            alt={openGuide === "install" ? "How to add the app to your home screen" : "How to enable push notifications"}
            onClick={(e) => e.stopPropagation()}
          />
        </div>
      )}

      {isAdmin && (
        <div className="wcf-console-section">
          <span className="wcf-console-section-label">Admin</span>
          <span className="wcf-console-section-rule" />
        </div>
      )}

      {isAdmin && (
        <div className="wcf-set-group">
          {newMembers}
          <AccordionSection
            icon={<SetIcon name="users" />}
            title="Manage roles"
            meta={`${profiles.length} players`}
            open={showRoles}
            onToggle={() => setShowRoles((v) => !v)}
          >
            {pushStats && (
              <div className="wcf-roles-stats">
                <div className="wcf-roles-stat">
                  <span className="wcf-roles-stat-num">{pushStats.subscribed}</span>
                  <span className="wcf-roles-stat-label">of {pushStats.total} get notifications</span>
                </div>
                <div className="wcf-roles-stat">
                  <span className="wcf-roles-stat-num">{profiles.length}</span>
                  <span className="wcf-roles-stat-label">members</span>
                </div>
              </div>
            )}
            {/* The two forms open on demand instead of always taking up the top. */}
            <div className="wcf-roles-tools">
              <button className={"wcf-roles-tool" + (openRoleTool === "add" ? " on" : "")} onClick={() => setOpenRoleTool((t) => (t === "add" ? null : "add"))}>
                + Add a player
              </button>
              <button
                className={"wcf-roles-tool" + (openRoleTool === "code" ? " on" : "")}
                onClick={() => setOpenRoleTool((t) => (t === "code" ? null : "code"))}
              >
                Send a login code
              </button>
            </div>
            {openRoleTool === "add" && <AddPlayerForm onAdd={onAddPlayer} />}
            {openRoleTool === "code" && <LoginCodeForm onGenerate={onGenerateLoginCode} />}

            <label className="wcf-roles-search-wrap">
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
                <circle cx="11" cy="11" r="7" />
                <path d="M20 20l-3.5-3.5" />
              </svg>
              <input
                className="wcf-roles-search"
                placeholder={`Search ${profiles.length} members…`}
                value={roleSearch}
                onChange={(e) => setRoleSearch(e.target.value)}
              />
            </label>
            {roleSearch.trim() && filteredRoleProfiles.length === 0 && <p className="wcf-empty small">No one matches &quot;{roleSearch.trim()}&quot;.</p>}
            <div className="wcf-roles-list">
              {filteredRoleProfiles.map((p) => {
                const isSelf = p.id === profile.id;
                // Owner rows are fully protected in the UI (SQL Editor only).
                // Co-owner rows can only be touched by the owner. Admins/
                // co-owners can promote a player, but only the owner can
                // touch an existing admin or co-owner's role.
                const canDelete = p.role === "player" ? !isSelf : p.role === "admin" || p.role === "co-owner" ? isOwner && !isSelf : false;
                const rated = adminRatings.some((r) => r.player_id === p.id);
                const menuOpen = roleMenuFor === p.id;
                const act = (fn: () => void) => {
                  setRoleMenuFor(null);
                  fn();
                };
                return (
                  <div key={p.id} className={"wcf-roles-row" + (menuOpen || renamingPlayerId === p.id || ratingPlayerId === p.id || creditFor === p.id ? " open" : "")}>
                    <div className="wcf-roles-row-top">
                      <Avatar name={p.display_name} avatarUrl={p.avatar_url} className="wcf-roles-avatar" background={avatarFor(p.display_name).gradient} />
                      <div className="wcf-roles-who">
                        <div className="wcf-roles-name">
                          {p.display_name}
                          {isSelf ? " (you)" : ""}
                          {p.role !== "player" && <span className={"wcf-role-badge small " + p.role}>{ROLE_LABEL[p.role]}</span>}
                        </div>
                        <div className="wcf-roles-sub">
                          {rated ? "Rated" : "Not rated"}
                          {credits.live && creditsOf(p.id) > 0 && <span className="wcf-roles-credit"> · {creditLabel(creditsOf(p.id))}</span>}
                        </div>
                      </div>
                      <button
                        className="wcf-roles-more"
                        onClick={() => setRoleMenuFor(menuOpen ? null : p.id)}
                        aria-label={`Actions for ${p.display_name}`}
                        aria-expanded={menuOpen}
                      >
                        ⋯
                      </button>
                    </div>

                    {menuOpen && (
                      <div className="wcf-roles-menu">
                        <button onClick={() => act(() => onToggleRatingPlayer(p.id))}>{rated ? "Edit rating" : "Rate player"}</button>
                        {credits.live && (
                          <button
                            onClick={() =>
                              act(() => {
                                setCreditFor(p.id);
                                setCreditNote("");
                              })
                            }
                          >
                            Add credit<small>One game they can use whenever they like</small>
                          </button>
                        )}
                        {credits.live && creditsOf(p.id) > 0 && (
                          <button
                            onClick={() =>
                              act(async () => {
                                if (await askConfirm(`Cancel one of ${p.display_name}'s credits?`, `They have ${creditLabel(creditsOf(p.id))}. This takes one away.`, "Cancel credit"))
                                  credits.cancelCredit(p.id);
                              })
                            }
                          >
                            Cancel a credit<small>They have {creditLabel(creditsOf(p.id))}</small>
                          </button>
                        )}
                        <button
                          onClick={() =>
                            act(() => {
                              setRenamingPlayerId(p.id);
                              setRenameDraft(p.display_name);
                            })
                          }
                        >
                          Rename
                        </button>
                        {p.role === "player" && (
                          <button
                            onClick={() =>
                              act(async () => {
                                if (
                                  await askConfirm(
                                    "Make admin?",
                                    `${p.display_name} will be able to manage fixtures, payments, and other players.`,
                                    "Make admin",
                                    false,
                                  )
                                )
                                  onSetRole(p.id, "admin");
                              })
                            }
                          >
                            Make admin<small>Can manage fixtures, payments and players</small>
                          </button>
                        )}
                        {p.role === "admin" && isOwner && (
                          <>
                            <button
                              onClick={() =>
                                act(async () => {
                                  if (
                                    await askConfirm(
                                      "Make co-owner?",
                                      `Only you'll be able to change or remove ${p.display_name}'s access afterwards.`,
                                      "Make co-owner",
                                      false,
                                    )
                                  )
                                    onSetRole(p.id, "co-owner");
                                })
                              }
                            >
                              Make co-owner
                            </button>
                            <button
                              onClick={() =>
                                act(async () => {
                                  const title = isSelf ? "Remove your own admin access?" : `Remove admin access from ${p.display_name}?`;
                                  const msg = isSelf
                                    ? "You'll need the owner (or the SQL Editor) to get it back."
                                    : "They'll go back to being a regular player.";
                                  if (await askConfirm(title, msg, "Remove admin")) onSetRole(p.id, "player");
                                })
                              }
                            >
                              Remove admin
                            </button>
                          </>
                        )}
                        {p.role === "co-owner" && isOwner && (
                          <button
                            onClick={() =>
                              act(async () => {
                                const title = isSelf ? "Remove your own co-owner access?" : `Remove co-owner access from ${p.display_name}?`;
                                const msg = isSelf ? "You'll need the owner to get it back." : "They'll become an admin.";
                                if (await askConfirm(title, msg, "Remove co-owner")) onSetRole(p.id, "admin");
                              })
                            }
                          >
                            Remove co-owner
                          </button>
                        )}
                        {p.avatar_url && (
                          <button
                            onClick={() =>
                              act(async () => {
                                if (
                                  await askConfirm(
                                    "Remove this photo?",
                                    `${p.display_name}'s profile photo will be deleted. They can add a new one any time.`,
                                    "Remove",
                                    true,
                                  )
                                )
                                  onAdminRemoveAvatar(p.id);
                              })
                            }
                          >
                            Remove photo
                          </button>
                        )}
                        {canDelete && (
                          <button className="danger" onClick={() => act(() => onDeleteProfile(p.id, p.display_name))}>
                            Delete account<small>Asks you to confirm first</small>
                          </button>
                        )}
                      </div>
                    )}

                    {creditFor === p.id && (
                      <div className="wcf-account-rename wcf-credit-add" style={{ marginTop: 10 }}>
                        <input value={creditNote} onChange={(e) => setCreditNote(e.target.value)} placeholder="Note (optional), e.g. paid cash, dropped out 12 Oct" aria-label="Note for the activity log" autoFocus />
                        <button
                          onClick={() => {
                            credits.addCredit(p.id, creditNote);
                            setCreditFor(null);
                          }}
                        >
                          Add 1 credit
                        </button>
                        <button className="wcf-ghost" onClick={() => setCreditFor(null)}>
                          Cancel
                        </button>
                      </div>
                    )}
                    {renamingPlayerId === p.id && (
                      <div className="wcf-account-rename" style={{ marginTop: 10 }}>
                        <input value={renameDraft} onChange={(e) => setRenameDraft(e.target.value)} autoFocus />
                        <button
                          disabled={!renameDraft.trim() || renameDraft.trim() === p.display_name}
                          onClick={async () => {
                            if (
                              await askConfirm(
                                "Change this player's name?",
                                `Change "${p.display_name}" to "${renameDraft.trim()}"? This is what shows on team sheets everywhere.`,
                                "Save",
                                false,
                              )
                            ) {
                              onAdminRename(p.id, renameDraft);
                              setRenamingPlayerId(null);
                            }
                          }}
                        >
                          Save
                        </button>
                        <button className="wcf-ghost" onClick={() => setRenamingPlayerId(null)}>
                          Cancel
                        </button>
                      </div>
                    )}
                    {ratingPlayerId === p.id && (
                      <div style={{ marginTop: 14 }}>
                        <RatingForm
                          initial={adminRatings.find((r) => r.player_id === p.id) ?? null}
                          onSave={(fitness, attack, defence, goalkeeping, position) => {
                            onSaveAdminRating(p.id, fitness, attack, defence, goalkeeping, position);
                            onToggleRatingPlayer(p.id);
                          }}
                          saveLabel={`Save ${p.display_name}'s rating`}
                          max={10}
                        />
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </AccordionSection>

          <AccordionSection
            icon={<SetIcon name="list" />}
            title="Activity log"
            meta={`${auditLog.length} entries`}
            open={showAuditLog}
            onToggle={onToggleAuditLog}
          >
            {auditLog.length === 0 && <p className="wcf-empty">No activity logged yet.</p>}
            <div className="wcf-audit-list">
              {auditLog.map((entry) => (
                <div key={entry.id} className="wcf-audit-row">
                  <span className="wcf-audit-dot" style={{ background: "var(--blue)" }} />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div className="wcf-audit-line">
                      <strong>{entry.actor?.display_name ?? "Someone"}</strong> {entry.action.toLowerCase()}
                      {entry.details ? ` — ${entry.details}` : ""}
                    </div>
                    <div className="wcf-audit-time">
                      {new Date(entry.created_at).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </AccordionSection>

          <AccordionSection
            icon={<SetIcon name="gear" />}
            title="Club settings"
            meta={`${clubSettings.team_white_name} vs ${clubSettings.team_red_name}`}
            open={openClubSettings}
            onToggle={() => setOpenClubSettings((v) => !v)}
          >
            <ClubSettingsForm settings={clubSettings} onSave={onSaveClubSettings} />
          </AccordionSection>

          <AccordionSection
            icon={<SetIcon name="trophy" />}
            title="Awards"
            meta={`${awards.length} published`}
            open={openAwards}
            onToggle={() => setOpenAwards((v) => !v)}
          >
            <AwardsForm awards={awards} onAdd={onAddAward} onDelete={onDeleteAward} askConfirm={askConfirm} />
          </AccordionSection>
        </div>
      )}

      <button className="wcf-signout" onClick={onSignOut}>
        Sign out
      </button>
    </div>
  );
}

export function AddPlayerForm({ onAdd }: { onAdd: (email: string, displayName: string) => Promise<boolean> }) {
  const [email, setEmail] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [adding, setAdding] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setAdding(true);
    const ok = await onAdd(email.trim(), displayName.trim());
    setAdding(false);
    if (ok) {
      setEmail("");
      setDisplayName("");
    }
  }

  return (
    <form className="wcf-add-player" onSubmit={submit}>
      <h3>Add a player</h3>
      <p className="wcf-board-note" style={{ margin: "0 0 10px" }}>
        For anyone who can&apos;t self sign up — they can then sign in with this email straight away.
      </p>
      <div className="wcf-team-settings">
        <label className="wcf-team-field wide">
          Email
          <input type="email" required value={email} onChange={(e) => setEmail(e.target.value)} placeholder="them@email.com" />
        </label>
        <label className="wcf-team-field wide">
          Display name (optional)
          <input value={displayName} onChange={(e) => setDisplayName(e.target.value)} placeholder="Defaults to their email" />
        </label>
      </div>
      <button className="wcf-save" type="submit" disabled={adding || !email.trim()}>
        {adding ? "Adding…" : "Add player"}
      </button>
    </form>
  );
}

export function AwardsForm({
  awards,
  onAdd,
  onDelete,
  askConfirm,
}: {
  awards: AwardRow[];
  onAdd: (title: string, value: string, note: string, imageFile: File | null, videoFile: File | null) => Promise<void>;
  onDelete: (id: string) => void;
  askConfirm: (title: string, message: string, confirmLabel?: string, danger?: boolean) => Promise<boolean>;
}) {
  const [title, setTitle] = useState("");
  const [value, setValue] = useState("");
  const [note, setNote] = useState("");
  const [imageFile, setImageFile] = useState<File | null>(null);
  const [videoFile, setVideoFile] = useState<File | null>(null);
  const [adding, setAdding] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setAdding(true);
    await onAdd(title.trim(), value.trim(), note.trim(), imageFile, videoFile);
    setAdding(false);
    setTitle("");
    setValue("");
    setNote("");
    setImageFile(null);
    setVideoFile(null);
  }

  return (
    <div className="wcf-club-settings">
      <h3>Awards & shoutouts</h3>

      {awards.map((a) => (
        <div key={a.id} className="wcf-award-row">
          <div className="wcf-award-top">
            <span className="wcf-award-title">{a.title}</span>
            <span className="wcf-award-value">{a.value}</span>
          </div>
          {a.note && <div className="wcf-award-note">{a.note}</div>}
          <div className="wcf-award-bottom">
            {a.image_url && <span className="wcf-award-tag">Photo</span>}
            {a.video_url && <span className="wcf-award-tag">🎥 Video</span>}
            <button
              className="wcf-admin-remove"
              style={{ marginLeft: "auto" }}
              onClick={async () => {
                if (await askConfirm(`Remove "${a.title}"?`, "This also deletes any photo/video attached to it.", "Remove")) onDelete(a.id);
              }}
              aria-label="Remove award"
            >
              ×
            </button>
          </div>
        </div>
      ))}

      <form onSubmit={submit}>
        <div className="wcf-team-settings">
          <label className="wcf-team-field wide">
            Title
            <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. Player of the Season" required />
          </label>
          <label className="wcf-team-field wide">
            Value
            <input value={value} onChange={(e) => setValue(e.target.value)} placeholder="e.g. Marcus, or 30 goals, or anything" required />
          </label>
          <label className="wcf-team-field wide">
            Note (optional)
            <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. voted by the squad" />
          </label>
        </div>
        <div className="wcf-upload-row">
          <label className="wcf-upload-box">
            <span className="wcf-upload-glyph">
              <svg
                viewBox="0 0 24 24"
                width="20"
                height="20"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.9"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z" />
                <circle cx="12" cy="13" r="4" />
              </svg>
            </span>
            <span className="wcf-upload-label">Photo</span>
            <span className="wcf-upload-state">{imageFile ? imageFile.name : "Optional"}</span>
            <input type="file" accept="image/*" style={{ display: "none" }} onChange={(e) => setImageFile(e.target.files?.[0] ?? null)} />
          </label>
          <label className="wcf-upload-box">
            <span className="wcf-upload-glyph">
              <svg
                viewBox="0 0 24 24"
                width="20"
                height="20"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.9"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <rect x="2" y="6" width="14" height="12" rx="2" />
                <path d="M16 10l6-3v10l-6-3" />
              </svg>
            </span>
            <span className="wcf-upload-label">Video</span>
            <span className="wcf-upload-state">{videoFile ? videoFile.name : `Under ${MAX_AWARD_VIDEO_MB}MB`}</span>
            <input type="file" accept="video/*" style={{ display: "none" }} onChange={(e) => setVideoFile(e.target.files?.[0] ?? null)} />
          </label>
        </div>
        <button className="wcf-save-amber" style={{ marginTop: 10 }} type="submit" disabled={adding || !title.trim() || !value.trim()}>
          {adding ? "Publishing…" : "Publish award"}
        </button>
      </form>
    </div>
  );
}

export function ClubSettingsForm({ settings, onSave }: { settings: ClubSettings; onSave: (patch: Partial<ClubSettings>) => void }) {
  const [form, setForm] = useState(settings);

  useEffect(() => setForm(settings), [settings]);

  const dirty = JSON.stringify(form) !== JSON.stringify(settings);
  const kickoffValid = /^([01]\d|2[0-3]):[0-5]\d$/.test(form.default_kickoff);

  return (
    <div className="wcf-club-settings">
      <h3>Club settings</h3>

      <div className="wcf-team-settings">
        <div className="wcf-team-row">
          <label className="wcf-team-field">
            Team A name
            <input value={form.team_white_name} onChange={(e) => setForm({ ...form, team_white_name: e.target.value })} />
          </label>
          <label className="wcf-team-field color">
            Colour
            <input type="color" value={form.team_white_color} onChange={(e) => setForm({ ...form, team_white_color: e.target.value })} />
          </label>
        </div>
        <div className="wcf-team-row">
          <label className="wcf-team-field">
            Team B name
            <input value={form.team_red_name} onChange={(e) => setForm({ ...form, team_red_name: e.target.value })} />
          </label>
          <label className="wcf-team-field color">
            Colour
            <input type="color" value={form.team_red_color} onChange={(e) => setForm({ ...form, team_red_color: e.target.value })} />
          </label>
        </div>
        <label className="wcf-team-field wide">
          Default venue for new fixtures
          <input value={form.default_venue} onChange={(e) => setForm({ ...form, default_venue: e.target.value })} placeholder="e.g. Guinea Gap" />
        </label>
        <label className="wcf-team-field wide">
          Default kickoff (24hr, e.g. 19:00)
          <input value={form.default_kickoff} onChange={(e) => setForm({ ...form, default_kickoff: e.target.value })} placeholder="19:00" inputMode="numeric" />
          {!kickoffValid && <span className="wcf-field-error">Use 24hr HH:MM, e.g. 19:00</span>}
        </label>
        <label className="wcf-team-field wide">
          Default pitch format
          <input value={form.default_pitch} onChange={(e) => setForm({ ...form, default_pitch: e.target.value })} placeholder="e.g. 8-a-side" />
        </label>
        <label className="wcf-team-field wide">
          Default match fee (£)
          <input
            type="number"
            min={0}
            step="0.5"
            value={form.default_price}
            onChange={(e) => setForm({ ...form, default_price: Number(e.target.value) || 0 })}
          />
        </label>
        <label className="wcf-team-field wide">
          Default squad size
          <input
            type="number"
            min={1}
            max={MAX_SPOTS}
            value={form.default_max_players}
            onChange={(e) => setForm({ ...form, default_max_players: Math.min(MAX_SPOTS, Number(e.target.value) || 0) })}
          />
        </label>
      </div>

      <button className="wcf-save" onClick={() => onSave(form)} disabled={!dirty || !kickoffValid}>
        Save settings
      </button>
    </div>
  );
}

export function LoginCodeForm({ onGenerate }: { onGenerate: (email: string) => Promise<string | null> }) {
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [code, setCode] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setCode(null);
    const result = await onGenerate(email.trim());
    setBusy(false);
    if (result) setCode(result);
  }

  return (
    <form className="wcf-add-player" onSubmit={submit}>
      <h3>Generate a login code</h3>
      <p className="wcf-board-note" style={{ margin: "0 0 10px" }}>
        For when someone isn&apos;t getting the sign-in email — creates a real code without sending it, so you can read it out to them directly.
      </p>
      <div className="wcf-team-settings">
        <label className="wcf-team-field wide">
          Their email
          <input type="email" required value={email} onChange={(e) => setEmail(e.target.value)} placeholder="them@email.com" />
        </label>
      </div>
      <button className="wcf-save" type="submit" disabled={busy || !email.trim()}>
        {busy ? "Generating…" : "Generate code"}
      </button>
      {code && (
        <div className="wcf-login-code">
          <span className="wcf-login-code-value">{code}</span>
          <span className="wcf-login-code-note">Expires soon — share it with them now, they enter it on the normal sign-in screen</span>
        </div>
      )}
    </form>
  );
}

export function RatingForm({
  initial,
  onSave,
  saveLabel,
  max = 5,
}: {
  initial: PlayerRating | null;
  onSave: (fitness: number, attack: number, defence: number, goalkeeping: number, position: PlayerPosition) => void;
  saveLabel: string;
  // Admin ratings go out of 10 (self stays out of 5) for finer balancing
  // precision - see the ratingByPlayer normalization where the two scales
  // get reconciled back to one for actual use.
  max?: number;
}) {
  const mid = Math.round(max / 2);
  const [fitness, setFitness] = useState(initial?.fitness ?? mid);
  const [attack, setAttack] = useState(initial?.attack ?? mid);
  const [defence, setDefence] = useState(initial?.defence ?? mid);
  const [goalkeeping, setGoalkeeping] = useState(initial?.goalkeeping ?? mid);
  const [position, setPosition] = useState<PlayerPosition>(initial?.position ?? "midfield");
  const metrics: { label: string; value: number; onChange: (n: number) => void }[] = [
    { label: "Fitness", value: fitness, onChange: setFitness },
    { label: "Attack", value: attack, onChange: setAttack },
    { label: "Defence", value: defence, onChange: setDefence },
    { label: "Goalkeeping", value: goalkeeping, onChange: setGoalkeeping },
  ];

  return (
    <div className="wcf-rating-form">
      {metrics.map((m) => (
        <div key={m.label} className="wcf-rating-row">
          <div className="wcf-rating-row-top">
            <span>{m.label}</span>
            <b>
              {m.value.toFixed(1)} / {max}
            </b>
          </div>
          <div className="wcf-rating-track">
            <div
              className="wcf-rating-fill"
              style={{
                width: `${(m.value / max) * 100}%`,
                background: `linear-gradient(90deg,${ratingFillColor((m.value / max) * 5)}99,${ratingFillColor((m.value / max) * 5)})`,
              }}
            />
          </div>
          <StarPicker value={m.value} onChange={m.onChange} max={max} />
        </div>
      ))}
      <div className="wcf-rating-row">
        <div className="wcf-rating-row-top">
          <span>Position</span>
        </div>
        <select value={position} onChange={(e) => setPosition(e.target.value as PlayerPosition)}>
          {POSITIONS.map((p) => (
            <option key={p} value={p}>
              {POSITION_LABEL[p]}
            </option>
          ))}
        </select>
      </div>
      <button className="wcf-save-red" onClick={() => onSave(fitness, attack, defence, goalkeeping, position)}>
        {saveLabel}
      </button>
    </div>
  );
}

export function StarPicker({ value, onChange, max = 5 }: { value: number; onChange: (n: number) => void; max?: number }) {
  return (
    <div className="wcf-star-picker">
      {Array.from({ length: max }, (_, i) => i + 1).map((n) => (
        <button key={n} type="button" className={"wcf-star" + (n <= value ? " on" : "")} onClick={() => onChange(n)} aria-label={`${n} of ${max}`}>
          ★
        </button>
      ))}
    </div>
  );
}
