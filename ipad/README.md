# iPad enforcement - Apple Screen Time (manual)

The iPad can't run an agent like the Mac/PC: iPadOS forbids any app from killing or blocking
other apps. So the iPad is handled with **Apple Screen Time**, managed from a parent device via
**Family Sharing**. This blocks games while leaving the internet and your productivity apps
working. It is **manual** - the Reward Vault tracks the reward economy, but a parent grants
iPad game time when it's earned (Screen Time has no way to read the vault).

## One-time setup

1. **Family Sharing + manage remotely (recommended).** On the parent's iPhone/iPad:
   Settings -> Screen Time -> Family -> (child) so you can configure and lock it from your own
   device. The child can't change what they can't access.
2. **Set a Screen Time passcode the child doesn't know** (Screen Time -> Lock Screen Time
   Settings / a passcode on the child's config). This is what makes it enforcement rather than
   a suggestion - without it the child can just turn limits off.

## Block games, keep internet + productivity apps

Use an **App Limit on the Games category** - it blocks games only, leaving Safari and
non-game apps untouched:

1. Screen Time -> **App Limits** -> **Add Limit**.
2. Tick the **Games** category (you can also tick "Entertainment" if some games hide there).
3. Set the limit to **1 minute**, and turn **Block at End of Limit** ON.
4. Result: games stop working after ~1 min/day; Safari/web, messaging, and productivity apps
   keep working normally.

### Allowing your "productivity games" (Chill with You, the co-op game)

Check each one's App Store category (its store page -> "Category"):
- **Not a Game** (e.g. Productivity / Lifestyle / Entertainment): it isn't covered by the Games
  limit - nothing to do.
- **Is a Game:** don't limit the whole Games category. Instead create the limit on the
  *specific* game apps you want blocked (App Limits lets you pick individual apps), and simply
  don't add the productivity ones. Also add the productivity apps to **Always Allowed**
  (Screen Time -> Always Allowed) so they stay reachable even during Downtime.

> Note: the exact interaction between "Always Allowed" and category App Limits varies by
> iPadOS version. If a whitelisted app still gets blocked by the category limit, switch to
> limiting individual game apps instead of the whole category.

## Granting earned time

When the child uses a reward in the vault, a parent grants iPad time one of these ways:
- On the child's iPad, open the blocked game -> **Ask For More Time** -> approve on the parent
  device (or enter the Screen Time passcode) -> choose the duration.
- Or temporarily raise/remove the Games limit, then restore it.

There's no automatic sync to the vault timer - treat the vault as the "bank" and Screen Time
as the lock the parent opens when time is earned.

## Stricter alternative: Downtime

If you'd rather block *everything* except a short allow-list: Screen Time -> **Downtime** ->
schedule it for the whole day, then add only the apps you permit (Safari, productivity apps,
comms) to **Always Allowed**. Everything else - including all games - is blocked until a parent
lifts Downtime. This over-blocks non-game apps unless you allow-list them, so the Games App
Limit above is usually the better fit for "block games, keep the internet."

## Why not Pi-hole / DNS on the iPad

DNS blocking via Pi-hole would be automatic from the vault, but it blocks the *internet*, not
games specifically, and is bypassable with the VPN profiles an iPad can carry. You asked to
block games without touching the internet, so Screen Time is the right tool here.
