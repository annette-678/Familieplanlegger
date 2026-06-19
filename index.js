/**
 * Familiekalender – Firebase Cloud Functions
 * Sender push-varsler:
 *   1. Øyeblikkelig – når noen legger inn en ny hendelse  ← Firestore-trigger
 *   2. Dagen før kl. 20:00                               ← Scheduled
 *   3. Samme morgen kl. 07:00                            ← Scheduled
 *   4. X minutter før hendelsen starter                  ← Scheduled
 *
 * Deploy: firebase deploy --only functions
 */

const functions = require("firebase-functions");
const admin     = require("firebase-admin");

admin.initializeApp();
const db = admin.firestore();

// ─── Trigger: ny hendelse lagt inn ───────────────────────────────────────────
// Fyrer av automatisk hver gang events-dokumentet skrives til i Firestore.
// Finner nye hendelser ved å sammenligne gammel og ny versjon av dokumentet,
// og sender varsel umiddelbart til alle registrerte enheter.

exports.notifyOnNewEvent = functions
  .region("europe-west1")
  .firestore.document("familiekalender/events")
  .onWrite(async (change) => {
    if (!change.after.exists) return null;

    const newData  = change.after.data()?.data  || {};
    const prevData = change.before.exists ? (change.before.data()?.data || {}) : {};

    const tokens = await getAllTokens();
    if (!tokens.length) return null;

    const toSend = [];
    const seenEventIds = new Set(); // unngå dupliserte varsler for flerdagshendelser

    for (const [dateStr, dayEvents] of Object.entries(newData)) {
      const prevIds = new Set((prevData[dateStr] || []).map(e => e.id));

      for (const ev of dayEvents) {
        // Kun send for hendelser som ikke fantes i forrige versjon
        if (prevIds.has(ev.id)) continue;
        // Kun ett varsel per hendelse, selv om den strekker seg over flere dager
        if (seenEventIds.has(ev.id)) continue;
        seenEventIds.add(ev.id);

        // Bruk hendelsens FØRSTE dag (dateStart) i varselteksten, ikke dagen vi tilfeldigvis møtte den på
        const firstDateStr = ev.dateStart || dateStr;
        const [y, mo, d]   = firstDateStr.split("-").map(Number);
        const dateObj      = new Date(y, mo - 1, d);
        const dayLabel     = formatDateLabel(dateObj);
        const timeLabel    = ev.time ? ` kl. ${ev.time}` : "";
        const spanLabel    = (ev.dateEnd && ev.dateEnd !== ev.dateStart) ? ` – ${formatDateLabel(new Date(...ev.dateEnd.split("-").map((v,i)=>i===1?v-1:Number(v))))}` : "";

        toSend.push({
          title: `📆 Ny hendelse: ${ev.title}`,
          body:  `${dayLabel}${spanLabel}${timeLabel} – ${eventMemberNames(ev)}`,
          tag:   `${ev.id}-new`,
        });
      }
    }

    if (!toSend.length) return null;

    const sends = toSend.flatMap(n =>
      tokens.map(token =>
        admin.messaging().send({
          token,
          notification: { title: n.title, body: n.body },
          webpush: {
            notification: {
              icon:     "/icon-192.png",
              badge:    "/badge-72.png",
              tag:      n.tag,
              renotify: true,
            },
            fcmOptions: { link: "/" },
          },
        }).catch(err => {
          if (err.code === "messaging/registration-token-not-registered") {
            return removeToken(token);
          }
        })
      )
    );

    await Promise.all(sends);
    console.log(`New-event: sent ${toSend.length} notification(s) to ${tokens.length} device(s)`);
    return null;
  });

// ─── Kjør hvert minutt ────────────────────────────────────────────────────────
exports.sendScheduledNotifications = functions
  .region("europe-west1")           // velg region nærmest dere
  .pubsub.schedule("every 1 minutes")
  .timeZone("Europe/Oslo")
  .onRun(async () => {
    const now    = new Date();
    const tokens = await getAllTokens();
    if (!tokens.length) return null;

    const eventsDoc = await db.collection("familiekalender").doc("events").get();
    if (!eventsDoc.exists) return null;
    const allEvents = eventsDoc.data().data || {};   // { "2026-06-10": [{...}] }

    const toSend = [];

    const seenReminderIds = new Set(); // unngå gjentatte påminnelser for flerdagshendelser

    for (const [dateStr, dayEvents] of Object.entries(allEvents)) {
      for (const ev of dayEvents) {
        if (!ev.time) continue;   // hopp over hendelser uten klokkeslett

        // Flerdagshendelser: kun beregn påminnelse ut fra FØRSTE dag (dateStart),
        // ellers ville samme tidspunkt trigget på nytt for hver dag hendelsen vises på
        const anchorDateStr = ev.dateStart || dateStr;
        if (anchorDateStr !== dateStr) continue;

        const [h, m]       = ev.time.split(":").map(Number);
        const [y, mo, d]   = anchorDateStr.split("-").map(Number);
        const eventTime    = new Date(y, mo - 1, d, h, m, 0);
        const msUntil      = eventTime - now;

        // Allerede passert
        if (msUntil < 0) continue;

        const minutesUntil = msUntil / 60000;
        const hoursUntil   = msUntil / 3600000;

        // ── 1. Dagen før kl. 20:00 ──────────────────────────────────────────
        // Vi sjekker om det er mellom 20:00 og 20:01 dagen FØR hendelsen
        const dayBefore = new Date(eventTime);
        dayBefore.setDate(dayBefore.getDate() - 1);
        dayBefore.setHours(20, 0, 0, 0);
        if (isWithinMinute(now, dayBefore)) {
          toSend.push({
            title: `📅 I morgen: ${ev.title}`,
            body:  `Kl. ${ev.time} – ${eventMemberNames(ev)}`,
            tag:   `${ev.id}-dayBefore`,
          });
        }

        // ── 2. Samme morgen kl. 07:00 ───────────────────────────────────────
        const sameDay7 = new Date(eventTime);
        sameDay7.setHours(7, 0, 0, 0);
        // Kun send dersom hendelsen er ETTER kl 07 (ellers sender vi etter)
        if (eventTime > sameDay7 && isWithinMinute(now, sameDay7)) {
          toSend.push({
            title: `☀️ I dag: ${ev.title}`,
            body:  `Kl. ${ev.time} – ${eventMemberNames(ev)}`,
            tag:   `${ev.id}-morning`,
          });
        }

        // ── 3. X minutter før (standard: 30 min, kan overstyres per hendelse) ─
        const reminderMinutes = ev.reminderMinutes ?? 30;
        const reminderTime    = new Date(eventTime.getTime() - reminderMinutes * 60000);
        if (isWithinMinute(now, reminderTime)) {
          const label = reminderMinutes >= 60
            ? `${reminderMinutes / 60} time${reminderMinutes > 60 ? "r" : ""}`
            : `${reminderMinutes} min`;
          toSend.push({
            title: `⏰ Om ${label}: ${ev.title}`,
            body:  `Kl. ${ev.time} – ${eventMemberNames(ev)}`,
            tag:   `${ev.id}-reminder`,
          });
        }
      }
    }

    if (!toSend.length) return null;

    // Send alle varsler til alle registrerte enheter
    const sends = toSend.flatMap(n =>
      tokens.map(token =>
        admin.messaging().send({
          token,
          notification: { title: n.title, body: n.body },
          webpush: {
            notification: {
              icon:  "/icon-192.png",
              badge: "/badge-72.png",
              tag:   n.tag,         // hindrer duplikater
              renotify: false,
            },
            fcmOptions: { link: "/" },
          },
        }).catch(err => {
          // Fjern utgytte tokens automatisk
          if (err.code === "messaging/registration-token-not-registered") {
            return removeToken(token);
          }
        })
      )
    );

    await Promise.all(sends);
    console.log(`Sent ${toSend.length} notification(s) to ${tokens.length} device(s)`);
    return null;
  });

// ─── Hjelpefunksjoner ─────────────────────────────────────────────────────────

/** Formaterer dato til lesbart norsk (I dag / I morgen / man 9. jun) */
function formatDateLabel(date) {
  const today    = new Date(); today.setHours(0,0,0,0);
  const tomorrow = new Date(today); tomorrow.setDate(today.getDate() + 1);
  if (date.toDateString() === today.toDateString())    return "I dag";
  if (date.toDateString() === tomorrow.toDateString()) return "I morgen";
  const days   = ["søn","man","tir","ons","tor","fre","lør"];
  const months = ["jan","feb","mar","apr","mai","jun","jul","aug","sep","okt","nov","des"];
  return `${days[date.getDay()]} ${date.getDate()}. ${months[date.getMonth()]}`;
}

/** Sjekk om now er innen 1 minutt etter target */
function isWithinMinute(now, target) {
  const diff = now - target;
  return diff >= 0 && diff < 60000;
}

const MEMBER_NAMES = {
  olemartin: "Ole Martin",
  annette:   "Annette",
  aria:      "Aria",
  falk:      "Falk",
  felles:    "Felles",
};
function memberName(id) {
  return MEMBER_NAMES[id] || id;
}
/** Slår sammen flere personer til lesbar tekst, f.eks. "Annette og Aria". Bakoverkompatibel med gamle hendelser (ev.member). */
function eventMemberNames(ev) {
  const ids = (ev.members && ev.members.length) ? ev.members : [ev.member];
  const names = ids.filter(Boolean).map(memberName);
  if (names.length <= 1) return names[0] || "";
  if (names.length === 2) return names.join(" og ");
  return names.slice(0, -1).join(", ") + " og " + names[names.length - 1];
}

/** Hent alle FCM-tokens fra Firestore */
async function getAllTokens() {
  try {
    const snap = await db.collection("familiekalender").doc("fcmTokens").get();
    if (!snap.exists) return [];
    const data = snap.data().tokens || {};
    // data = { userId: { deviceId: token, ... }, ... }
    return Object.values(data).flatMap(userTokens => Object.values(userTokens));
  } catch (e) {
    console.error("Could not fetch tokens:", e);
    return [];
  }
}

/** Fjern et token som ikke lenger er gyldig */
async function removeToken(token) {
  try {
    const snap = await db.collection("familiekalender").doc("fcmTokens").get();
    if (!snap.exists) return;
    const data = snap.data().tokens || {};
    for (const [uid, userTokens] of Object.entries(data)) {
      for (const [did, t] of Object.entries(userTokens)) {
        if (t === token) {
          delete data[uid][did];
        }
      }
    }
    await db.collection("familiekalender").doc("fcmTokens").set({ tokens: data });
  } catch (e) {
    console.error("Could not remove token:", e);
  }
}
