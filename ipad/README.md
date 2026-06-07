# iPad enforcement via Screen Time - managed from your MacBook

The iPad can't run an agent like the Mac/PC (iPadOS forbids apps from killing/blocking other
apps), so it's handled with **Apple Screen Time**, set up and managed remotely from your
**MacBook** through **Family Sharing**. This blocks games while leaving the internet and your
productivity apps working. It is **manual**: the Reward Vault is the "bank" that tracks earned
time; a parent opens the lock on the iPad when time is earned (Screen Time can't read the vault).

---

## What you need first (one-time)

1. **Your MacBook is signed into YOUR Apple Account** (the one that will be the family
   organizer).
2. **The iPad is signed into the CHILD's own Apple Account** - a family member account, not
   yours. This is the part that makes remote management work. If the iPad is currently on your
   Apple ID, see **"If the iPad is on your Apple ID"** at the bottom.

---

## 1. Set up Family Sharing + the child account (on the MacBook)

1. Apple menu -> **System Settings** -> click **Family** (top of the sidebar, under your name).
2. If Family Sharing isn't set up yet, click **Set Up Family** and follow the prompts (you
   become the **organizer**).
3. **Add the child:** click **Add Member** ->
   - **Create Child Account** if they don't have an Apple Account yet (best for a kid - it's
     created inside your family and is manageable), **or**
   - **Invite** their existing Apple Account if they already have one.
4. On the **iPad**: Settings -> sign in as the **child's** Apple Account (if it isn't already).

---

## 2. Turn on Screen Time for the child (on the MacBook)

1. System Settings -> **Screen Time**.
2. At the top of the Screen Time panel, use the **family member selector** and pick the
   **child**. (If you don't see it, the child account / Family Sharing from step 1 isn't fully
   set up yet.)
3. Turn on **App & Website Activity** if prompted (Screen Time needs it to enforce limits).
4. Scroll down and set **Lock Screen Time Settings** -> create a **4-digit Screen Time
   passcode the child does NOT know**. This is what turns it from a suggestion into
   enforcement - without it the child can just switch limits off. (Don't reuse the iPad unlock
   code.)

---

## 3. Block games, keep the internet (on the MacBook, for the child)

Use an **App Limit on the Games category** - it blocks games only and leaves Safari and
normal apps alone:

1. Screen Time (child selected) -> **App Limits** -> **Add Limit** (the **+**).
2. Tick the **Games** category. (You can also tick **Entertainment** if some games hide there.)
3. Set the time to **1 minute**.
4. Turn on **Block at End of Limit** (so it hard-blocks instead of just warning).
5. Save. Result: games stop after ~1 min/day; web, messaging, and productivity apps keep
   working.

---

## 4. Allow your productivity "games"

Check each one's App Store category (its store page -> Information -> Category):
- **Not a Game** (Productivity / Lifestyle / Entertainment): the Games limit doesn't touch it -
  nothing to do.
- **Is a Game:** don't limit the whole Games category. Instead, in **Add Limit**, expand the
  Games category and pick the **specific game apps** you want blocked (leave the productivity
  ones unticked). Also add the productivity apps under **Screen Time -> Always Allowed** so
  they stay reachable.

> The interaction between "Always Allowed" and a category limit varies by iPadOS version. If a
> whitelisted app still gets blocked by the category limit, switch to limiting individual game
> apps instead of the whole category.

---

## 5. Granting earned time (when a reward is used in the vault)

Any of these, from your MacBook or iPhone:
- The child opens the blocked game and taps **Ask For More Time** -> you get a notification ->
  **Approve** and choose a duration (15 min / 1 hour / all day).
- Or open Screen Time (child selected) -> App Limits -> the Games limit -> raise the time or
  toggle the limit off, then restore it afterward.

There's no automatic sync to the vault timer - treat the vault as the ledger and Screen Time as
the lock you open when time is earned.

---

## Verify it works

1. On the iPad, after the 1-minute games allowance is used up, a game should show the Screen
   Time block screen ("You've reached your limit").
2. Safari and your productivity apps still open normally.
3. From the MacBook, approve an "Ask For More Time" request and confirm the game opens.
4. Confirm the child **cannot** change limits without the Screen Time passcode.

---

## If the iPad is on YOUR Apple ID (no separate child account)

Remote management needs the child's own account. If you'd rather not move the iPad to a child
account, set Screen Time up **directly on the iPad** instead - same steps as 2-4 but in the
iPad's Settings -> Screen Time, and set the Screen Time passcode there. You then manage it on
the iPad itself (not from the Mac), but blocking and "Ask For More Time" still work.

## Why not Pi-hole / DNS for the iPad

DNS blocking via Pi-hole would be automatic from the vault, but it blocks the *internet*, not
games specifically, and is bypassable with a VPN profile. You asked to block games without
touching the internet, so Screen Time is the right tool here.
