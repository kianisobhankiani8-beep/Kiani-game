let challengePoll = null, roomPoll = null, rndPoll = null;
let rndRoomId = null, rndLockedStake = 0, lastHandJson = "";
const seenChallenges = new Set(), paidRooms = new Set();

function enterOnlineGame(roomId) {
  if (currentRoomId === roomId && $h("hokm-screen").style.display === "flex") return;
  clearMatchTimer();
  closeModal();
  isOnlineMode = true; lastHandJson = "";
  $("app").style.display = "none";
  $h("hokm-screen").style.display = "flex";
  ["hokm-modeOv", "lobbyOff", "lobbyOnline", "lobby1v1", "end", "rov", "trumpOv"]
    .forEach(i => $h(i).classList.add("h"));
  joinOnlineRoom(roomId);
}

async function joinOnlineRoom(roomId) {
  currentRoomId = roomId;
  $h("rnd").textContent = "اتاق پیدا شد. در حال پخش کارت‌ها...";
  try {
    const { data: room0 } = await db.from("game_rooms").select("*").eq("id", roomId).single();
    const { data: me } = await db.from("game_players").select("seat")
      .eq("room_id", roomId).eq("profile_id", currentUser.id).maybeSingle();
    if (!room0 || room0.mode !== "1v1" || !me || me.seat === 0) {
      const res = await fetch(`${SUPABASE_URL}/functions/v1/game-engine`, {
        method: "POST",
        headers: { "Authorization": `Bearer ${SUPABASE_KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify({ action: "start_game", room_id: roomId })
      });
      const d = await res.json().catch(() => ({}));
      if (!res.ok || d.error) toast("خطای موتور بازی: " + (d.error || res.status), true);
    }
  } catch (e) { toast("خطا: " + e.message, true); }

  if (roomPoll) clearInterval(roomPoll);
  const tick = async () => {
    if (currentRoomId !== roomId) { clearInterval(roomPoll); return; }
    try {
      const { data: room } = await db.from("game_rooms").select("*").eq("id", roomId).single();
      if (room) {
        renderOnlineState(room);
        if (room.status === "finished" && !paidRooms.has(room.id)) { paidRooms.add(room.id); handleOnlinePayout(room); }
      }
      const { data: hand } = await db.from("game_hands").select("cards")
        .eq("room_id", roomId).eq("profile_id", currentUser.id).maybeSingle();
      if (hand && hand.cards) {
        const j = JSON.stringify(hand.cards);
        if (j !== lastHandJson) { lastHandJson = j; renderOnlineHand(hand.cards); }
      }
    } catch (e) {}
  };
  tick();
  roomPoll = setInterval(tick, 1500);
}

function listenForIncomingChallenges() {
  if (challengePoll) clearInterval(challengePoll);
  challengePoll = setInterval(async () => {
    if (!currentUser) return;
    try {
      const rows = await supabaseFetch("challenges?challenged_id=eq." + currentUser.id + "&status=eq.pending&limit=10");
      const c = (rows || []).find(r => !seenChallenges.has(r.id));
      if (!c) return;
      seenChallenges.add(c.id);
      const u = await supabaseFetch("users?id=eq." + c.challenger_id);
      showChallengeInvite(c.id, u && u[0] ? u[0].username : "نامشخص", c.stake, c.mode);
    } catch (e) {}
  }, 3000);
}

async function acceptChallenge(challengeId, challengerName, stake) {
  closeModal();
  stake = Number(stake) || 0;
  let locked = false;
  try {
    const cd = await supabaseFetch("challenges?id=eq." + challengeId);
    if (!cd || !cd.length || cd[0].status !== "pending") return toast("این چالش دیگر معتبر نیست", true);
    if (stake > 0) { await Wallet.lock(stake); locked = true; }
    const { data: room, error } = await db.from("game_rooms").insert({
      status: "playing", mode: "1v1", stake, current_turn: 0, creator_id: cd[0].challenger_id
    }).select().single();
    if (error || !room) throw new Error(error ? error.message : "خطا در ساخت اتاق");
    const { error: e2 } = await db.from("game_players").insert([
      { room_id: room.id, profile_id: cd[0].challenger_id, seat: 0, team: 0, is_bot: false },
      { room_id: room.id, profile_id: currentUser.id, seat: 1, team: 1, is_bot: false }
    ]);
    if (e2) throw new Error(e2.message);
    await supabaseFetch("challenges?id=eq." + challengeId, {
      method: "PATCH", body: JSON.stringify({ status: "accepted", room_id: room.id })
    });
    toast("چالش پذیرفته شد! در حال شروع...");
    enterOnlineGame(room.id);
  } catch (e) {
    if (locked) { try { await Wallet.payout(stake); } catch (x) {} }
    toast("خطا: " + e.message, true);
  }
}

function listenForChallengeAccepted(challengeId, stake) {
  let n = 0;
  const t = setInterval(async () => {
    n++;
    try {
      const r = await supabaseFetch("challenges?id=eq." + challengeId);
      const c = r && r[0]; if (!c) return;
      if (c.status === "accepted" && c.room_id) {
        clearInterval(t); toast("حریف چالش را پذیرفت! در حال شروع...");
        enterOnlineGame(c.room_id);
      } else if (c.status === "rejected") {
        clearInterval(t); toast("حریف چالش را رد کرد", true);
        if (stake > 0) await Wallet.payout(stake);
      } else if (n > 100) {
        clearInterval(t);
        const x = await supabaseFetch("challenges?id=eq." + challengeId + "&status=eq.pending",
          { method: "PATCH", body: JSON.stringify({ status: "expired" }) });
        if (x && x.length && stake > 0) await Wallet.payout(stake);
      }
    } catch (e) {}
  }, 3000);
}

function clearRandomPvpTimer() {
  if (randomPvpTimerId) { clearInterval(randomPvpTimerId); randomPvpTimerId = null; }
  if (rndPoll) { clearInterval(rndPoll); rndPoll = null; }
  if (rndRoomId) {
    const id = rndRoomId; rndRoomId = null;
    db.from("game_rooms").update({ status: "finished" }).eq("id", id).eq("status", "waiting").then(() => {});
  }
  if (rndLockedStake > 0) { const s = rndLockedStake; rndLockedStake = 0; Wallet.payout(s); }
  const tb = $h("randPvpTimer"); if (tb) tb.classList.remove("on");
  const rb = $h("btnRandomPvp"); if (rb) rb.disabled = false;
  randomPvpMatchActive = false;
}

async function startRandomPvpMatch() {
  if (randomPvpMatchActive) return;
  const stake = pvpMode === "bet" ? pvpStake : 0;
  if (stake > 0) {
    if (currentUser.tokens < stake) return toast("موجودی کافی نیست", true);
    try { await Wallet.lock(stake); } catch (e) { return toast(e.message, true); }
    rndLockedStake = stake;
  }
  randomPvpMatchActive = true;
  $h("btnRandomPvp").disabled = true;
  $h("randPvpTimer").classList.add("on");
  const secEl = $h("randPvpSec");
  let sec = 30, busy = false;
  secEl.textContent = String(sec);

  const matched = (roomId) => {
    rndLockedStake = 0; rndRoomId = null;
    clearRandomPvpTimer();
    toast("حریف پیدا شد! در حال شروع...");
    enterOnlineGame(roomId);
  };
  const createMyRoom = async () => {
    const { data: room, error } = await db.from("game_rooms").insert({
      status: "waiting", mode: "1v1", stake, current_turn: 0, creator_id: currentUser.id
    }).select().single();
    if (error || !room) { console.warn(error); return; }
    await db.from("game_players").insert({ room_id: room.id, profile_id: currentUser.id, seat: 0, team: 0, is_bot: false });
    rndRoomId = room.id;
  };
  const cancelMine = async () => {
    const { data } = await db.from("game_rooms").update({ status: "finished" })
      .eq("id", rndRoomId).eq("status", "waiting").select();
    return !!(data && data.length);
  };

  const tick = async () => {
    if (busy || !randomPvpMatchActive) return;
    busy = true;
    try {
      if (rndRoomId) {
        const { data: r } = await db.from("game_rooms").select("status").eq("id", rndRoomId).single();
        if (r && r.status === "playing") return matched(rndRoomId);
      }
      const since = new Date(Date.now() - 60000).toISOString();
      const { data: rooms } = await db.from("game_rooms").select("id")
        .eq("mode", "1v1").eq("status", "waiting").eq("stake", stake)
        .lt("creator_id", currentUser.id).gt("created_at", since).limit(5);
      for (const r of rooms || []) {
        if (rndRoomId) {
          if (!(await cancelMine())) return;
          rndRoomId = null;
        }
        const { data: cl } = await db.from("game_rooms").update({ status: "playing" })
          .eq("id", r.id).eq("status", "waiting").select();
        if (cl && cl.length) {
          const { error } = await db.from("game_players").insert({
            room_id: r.id, profile_id: currentUser.id, seat: 1, team: 1, is_bot: false });
          if (!error) return matched(r.id);
        }
      }
      if (!rndRoomId) await createMyRoom();
    } catch (e) { console.warn("match err", e); }
    finally { busy = false; }
  };

  tick();
  rndPoll = setInterval(tick, 2000);
  randomPvpTimerId = setInterval(async () => {
    sec--; secEl.textContent = String(Math.max(0, sec));
    if (sec > 0) return;
    clearInterval(randomPvpTimerId); randomPvpTimerId = null;
    if (rndRoomId && !(await cancelMine())) {
      const id = rndRoomId; return matched(id);
    }
    rndRoomId = null; rndLockedStake = 0;
    clearRandomPvpTimer();
    await startPvpWithBot();
  }, 1000);
}
