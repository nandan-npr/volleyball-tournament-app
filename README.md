# VolleyLive — Volleyball Tournament App (Supabase Edition)

A responsive, real-time React + Supabase application for a four-team **League + Knockout** volleyball tournament.

## Features

- **No spectator login or signup**: Anyone with the public 8-character Tournament ID can view tournament fixtures, teams, live scores, points tables, and champion statuses.
- **Strong Organizer Security**:
  - The organizer receives a separate, high-entropy private key (e.g., `adm_...`) upon creating a tournament.
  - The database stores **only a cryptographic SHA-256 hash** of this key in a private table (`organizer_credentials`).
  - Public queries can never read organizer credentials or phone numbers.
  - All write operations (team management, fixture generation, score entry, knockout setup, champion confirmation) are mediated by PostgreSQL `SECURITY DEFINER` RPC functions that verify the key on the database server.
  - Organizers can recover access or securely manage tournaments from another device by entering their private organizer key.
- **Volleyball Rules Enforced on Server**:
  - Best of 3 sets.
  - Sets 1 & 2 played to 25 points, win by at least 2 points.
  - Deciding Set 3 played to 15 points, win by at least 2 points.
  - First team to win 2 sets wins the match. Invalid scores and ties are strictly rejected by the database.
- **League + Knockout Progression**:
  - 4 teams, 6 round-robin fixtures.
  - Points model: 3 pts for 2–0 win, 2 pts for 2–1 win, 1 pt for 1–2 loss, 0 pts for 0–2 loss.
  - Tie-breaker: Points descending, then Set differential `(Sets For - Sets Against)` descending.
  - Semifinals: 1st vs 4th (`semi_1`), 2nd vs 3rd (`semi_2`).
  - Final: Winner of `semi_1` vs Winner of `semi_2`.
- **Supabase Realtime Live Scoring**:
  - When an organizer inputs a score, spectators across all connected devices and browsers receive instant updates via Supabase Realtime without refreshing.

---

## Supabase Configuration

The application reads your Supabase credentials from environment variables:

```env
VITE_SUPABASE_URL=https://your-project-id.supabase.co
VITE_SUPABASE_PUBLISHABLE_KEY=your-supabase-publishable-key
```

### Applying Database Migrations in Supabase

1. **Initial Migration**: `supabase/migrations/20261107000000_vollylive_schema.sql` (already executed).
2. **Security & Management Patch**: `supabase/migrations/20261107000001_organizer_management_and_scoring.sql`
   - Run this in your Supabase SQL Editor to add `is_starter` to players, `is_manual` and `scheduled_time` to matches, and activate the new secure RPC functions:
     - `rpc_update_team` & `rpc_delete_team` (with match safety checks)
     - `rpc_add_player`, `rpc_update_player`, `rpc_delete_player` (minimum 6 validation), and `rpc_set_starters` (exactly 6 court starters)
     - `rpc_create_manual_match` (distinct registered teams validation)
     - `rpc_update_match_score` with score override protection for completed matches.

To execute in Supabase SQL Editor:
1. Open [Supabase Dashboard](https://supabase.com/dashboard) -> **SQL Editor** -> **New Query**.
2. Copy and paste the contents of `supabase/migrations/20261107000001_organizer_management_and_scoring.sql`.
3. Click **Run**. Confirm execution completes successfully.

### Enabling Realtime in Supabase

The SQL migration automatically adds the tables to the `supabase_realtime` publication:
- `tournaments`
- `teams`
- `players`
- `matches`
- `match_sets`

To verify in the Supabase Dashboard:
1. Go to **Database** → **Publications** in the Supabase left menu.
2. Select `supabase_realtime`.
3. Verify that the tables `tournaments`, `teams`, `players`, `matches`, and `match_sets` are toggled ON for replication.

---

## Testing Tournament Flow Across Devices

1. **Device A (Organizer)**:
   - Click **Create tournament**.
   - Enter tournament name, organizer name, phone number, location, and date.
   - Click **Create tournament**.
   - Copy the displayed **Tournament ID** (e.g. `ABC12345`) and the **Private Organizer Key** (e.g. `adm_...`).
   - Add 4 teams with at least 6 player names each.
   - Click **Generate 6 league matches**.

2. **Device B (Spectator)**:
   - Open the application.
   - Click **View tournament** and enter the Tournament ID (or open the shared link `?id=ABC12345`).
   - Notice that the 4 teams and 6 upcoming league fixtures are instantly visible in view-only mode.

3. **Live Scoring**:
   - On **Device A**, open any match and enter set scores (e.g. Set 1: 25–21, Set 2: 25–23). Click **Save score**.
   - On **Device B**, watch the match card and points table update automatically in real time without refreshing.

4. **Tournament Progression**:
   - Complete all 6 league matches.
   - Click **Generate semi-finals** on Device A. Matches 7 and 8 appear based on league standings.
   - Complete both semi-finals. Click **Create final**.
   - Complete the final match and click **Confirm tournament winner**.
   - The tournament champion banner appears immediately for all spectators.

5. **Organizer Key Verification & Session Control**:
   - On a new device or browser, spectators only ever see the live scoreboard.
   - To unlock organizer tools, click the discreet **Organizer Access** button in the header or home screen.
   - Enter your public **Tournament ID** and private **Organizer Key**.
   - The key is cryptographically verified against the database (`rpc_verify_organizer`).
   - Organizer privileges are stored exclusively in scoped `sessionStorage` for that specific tournament.
   - Clicking **Lock & Exit** instantly logs out the organizer and returns the UI to spectator-only mode.
   - Access does not carry over to any other tournament.

---

## Local Development

```bash
npm install
npm run dev
```

Build and test production bundle:
```bash
npm run build
npm run lint
```
