-- ============================================================================
-- VolleyLive: Complete Supabase Relational Schema & Secure RPC Functions
-- ============================================================================

-- Enable required extensions
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ----------------------------------------------------------------------------
-- 1. Table Definitions
-- ----------------------------------------------------------------------------

-- Tournaments table (Public read, RPC-only writes)
CREATE TABLE IF NOT EXISTS public.tournaments (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tournament_code TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    organizer_name TEXT NOT NULL,
    location TEXT NOT NULL,
    tournament_date DATE,
    format TEXT NOT NULL DEFAULT 'League + Knockout',
    teams_limit INT NOT NULL DEFAULT 4,
    match_format TEXT NOT NULL DEFAULT 'Best of 3',
    status TEXT NOT NULL DEFAULT 'registration' CHECK (status IN ('registration', 'league', 'knockout', 'final', 'completed')),
    winner_id UUID,
    winner_name TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Organizer Credentials (Private — NEVER exposed via public SELECT)
CREATE TABLE IF NOT EXISTS public.organizer_credentials (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tournament_id UUID NOT NULL UNIQUE REFERENCES public.tournaments(id) ON DELETE CASCADE,
    phone TEXT NOT NULL,
    admin_token_hash TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Teams table
CREATE TABLE IF NOT EXISTS public.teams (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tournament_id UUID NOT NULL REFERENCES public.tournaments(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    captain TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT unique_team_name_per_tournament UNIQUE (tournament_id, name)
);

-- Players table
CREATE TABLE IF NOT EXISTS public.players (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    team_id UUID NOT NULL REFERENCES public.teams(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    player_order INT NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Matches table
CREATE TABLE IF NOT EXISTS public.matches (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tournament_id UUID NOT NULL REFERENCES public.tournaments(id) ON DELETE CASCADE,
    match_identifier TEXT NOT NULL,
    match_number INT NOT NULL,
    stage TEXT NOT NULL CHECK (stage IN ('league', 'knockout')),
    round TEXT NOT NULL,
    team_a_id UUID REFERENCES public.teams(id) ON DELETE SET NULL,
    team_b_id UUID REFERENCES public.teams(id) ON DELETE SET NULL,
    status TEXT NOT NULL DEFAULT 'upcoming' CHECK (status IN ('upcoming', 'live', 'completed')),
    winner_id UUID REFERENCES public.teams(id) ON DELETE SET NULL,
    winner_name TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT unique_match_identifier_per_tournament UNIQUE (tournament_id, match_identifier)
);

-- Add foreign key constraint to tournaments.winner_id now that teams exists
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'fk_tournaments_winner'
    ) THEN
        ALTER TABLE public.tournaments
        ADD CONSTRAINT fk_tournaments_winner
        FOREIGN KEY (winner_id) REFERENCES public.teams(id) ON DELETE SET NULL;
    END IF;
END $$;

-- Match sets table (Stores individual set scores)
CREATE TABLE IF NOT EXISTS public.match_sets (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    match_id UUID NOT NULL REFERENCES public.matches(id) ON DELETE CASCADE,
    set_number INT NOT NULL CHECK (set_number BETWEEN 1 AND 3),
    team_a_points INT NOT NULL DEFAULT 0 CHECK (team_a_points >= 0 AND team_a_points <= 99),
    team_b_points INT NOT NULL DEFAULT 0 CHECK (team_b_points >= 0 AND team_b_points <= 99),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT unique_match_set_number UNIQUE (match_id, set_number)
);

-- ----------------------------------------------------------------------------
-- 2. Indexes for Performance
-- ----------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_tournaments_code ON public.tournaments(tournament_code);
CREATE INDEX IF NOT EXISTS idx_teams_tournament ON public.teams(tournament_id);
CREATE INDEX IF NOT EXISTS idx_players_team ON public.players(team_id);
CREATE INDEX IF NOT EXISTS idx_matches_tournament ON public.matches(tournament_id, match_number);
CREATE INDEX IF NOT EXISTS idx_match_sets_match ON public.match_sets(match_id, set_number);

-- ----------------------------------------------------------------------------
-- 3. Row Level Security (RLS) Configuration
-- ----------------------------------------------------------------------------
ALTER TABLE public.tournaments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.organizer_credentials ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.teams ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.players ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.matches ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.match_sets ENABLE ROW LEVEL SECURITY;

-- Public Spectator Read Policies (Any spectator can read public tournament data)
DROP POLICY IF EXISTS "Public can view tournaments" ON public.tournaments;
CREATE POLICY "Public can view tournaments" ON public.tournaments
    FOR SELECT TO anon, authenticated USING (true);

DROP POLICY IF EXISTS "Public can view teams" ON public.teams;
CREATE POLICY "Public can view teams" ON public.teams
    FOR SELECT TO anon, authenticated USING (true);

DROP POLICY IF EXISTS "Public can view players" ON public.players;
CREATE POLICY "Public can view players" ON public.players
    FOR SELECT TO anon, authenticated USING (true);

DROP POLICY IF EXISTS "Public can view matches" ON public.matches;
CREATE POLICY "Public can view matches" ON public.matches
    FOR SELECT TO anon, authenticated USING (true);

DROP POLICY IF EXISTS "Public can view match sets" ON public.match_sets;
CREATE POLICY "Public can view match sets" ON public.match_sets
    FOR SELECT TO anon, authenticated USING (true);

-- NO SELECT policy on organizer_credentials (completely inaccessible to public/anon)
DROP POLICY IF EXISTS "No public access to organizer_credentials" ON public.organizer_credentials;

-- ----------------------------------------------------------------------------
-- 4. Enable Supabase Realtime
-- ----------------------------------------------------------------------------
ALTER TABLE public.tournaments REPLICA IDENTITY FULL;
ALTER TABLE public.teams REPLICA IDENTITY FULL;
ALTER TABLE public.players REPLICA IDENTITY FULL;
ALTER TABLE public.matches REPLICA IDENTITY FULL;
ALTER TABLE public.match_sets REPLICA IDENTITY FULL;

DO $$
BEGIN
    BEGIN
        ALTER PUBLICATION supabase_realtime ADD TABLE public.tournaments;
    EXCEPTION WHEN duplicate_object THEN END;
    BEGIN
        ALTER PUBLICATION supabase_realtime ADD TABLE public.teams;
    EXCEPTION WHEN duplicate_object THEN END;
    BEGIN
        ALTER PUBLICATION supabase_realtime ADD TABLE public.players;
    EXCEPTION WHEN duplicate_object THEN END;
    BEGIN
        ALTER PUBLICATION supabase_realtime ADD TABLE public.matches;
    EXCEPTION WHEN duplicate_object THEN END;
    BEGIN
        ALTER PUBLICATION supabase_realtime ADD TABLE public.match_sets;
    EXCEPTION WHEN duplicate_object THEN END;
END $$;

-- ----------------------------------------------------------------------------
-- 5. Helper Internal Function: Verify Organizer Credentials
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public._verify_organizer(
    p_tournament_id UUID,
    p_admin_token TEXT
) RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
    v_stored_hash TEXT;
    v_incoming_hash TEXT;
BEGIN
    IF p_tournament_id IS NULL OR p_admin_token IS NULL OR trim(p_admin_token) = '' THEN
        RETURN FALSE;
    END IF;

    SELECT admin_token_hash INTO v_stored_hash
    FROM public.organizer_credentials
    WHERE tournament_id = p_tournament_id;

    IF v_stored_hash IS NULL THEN
        RETURN FALSE;
    END IF;

    -- Calculate SHA-256 lowercase hex hash
    v_incoming_hash := encode(sha256(convert_to(trim(p_admin_token), 'UTF8')), 'hex');
    RETURN (v_stored_hash = v_incoming_hash);
END;
$$;

-- ----------------------------------------------------------------------------
-- 6. RPC: Create Tournament
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.rpc_create_tournament(
    p_name TEXT,
    p_organizer_name TEXT,
    p_phone TEXT,
    p_location TEXT,
    p_date DATE,
    p_admin_token_hash TEXT
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
    v_code TEXT;
    v_tournament_id UUID;
    v_chars TEXT := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    v_i INT;
    v_exists BOOLEAN;
BEGIN
    -- Validate required fields
    IF trim(COALESCE(p_name, '')) = '' THEN
        RAISE EXCEPTION 'Tournament name is required.';
    END IF;
    IF trim(COALESCE(p_organizer_name, '')) = '' THEN
        RAISE EXCEPTION 'Organizer name is required.';
    END IF;
    IF trim(COALESCE(p_phone, '')) = '' THEN
        RAISE EXCEPTION 'Mobile number is required.';
    END IF;
    IF trim(COALESCE(p_location, '')) = '' THEN
        RAISE EXCEPTION 'Tournament location is required.';
    END IF;
    IF trim(COALESCE(p_admin_token_hash, '')) = '' THEN
        RAISE EXCEPTION 'Organizer credential hash is required.';
    END IF;

    -- Generate unique 8-character tournament code
    LOOP
        v_code := '';
        FOR v_i IN 1..8 LOOP
            v_code := v_code || substr(v_chars, floor(random() * length(v_chars) + 1)::int, 1);
        END LOOP;

        SELECT EXISTS (
            SELECT 1 FROM public.tournaments WHERE tournament_code = v_code
        ) INTO v_exists;

        EXIT WHEN NOT v_exists;
    END LOOP;

    -- Insert tournament record
    INSERT INTO public.tournaments (
        tournament_code,
        name,
        organizer_name,
        location,
        tournament_date,
        format,
        teams_limit,
        match_format,
        status
    ) VALUES (
        v_code,
        trim(p_name),
        trim(p_organizer_name),
        trim(p_location),
        p_date,
        'League + Knockout',
        4,
        'Best of 3',
        'registration'
    ) RETURNING id INTO v_tournament_id;

    -- Store private credentials (isolated from public view)
    INSERT INTO public.organizer_credentials (
        tournament_id,
        phone,
        admin_token_hash
    ) VALUES (
        v_tournament_id,
        trim(p_phone),
        trim(p_admin_token_hash)
    );

    RETURN jsonb_build_object(
        'tournament_id', v_tournament_id,
        'tournament_code', v_code
    );
END;
$$;

-- ----------------------------------------------------------------------------
-- 7. RPC: Verify Organizer Access
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.rpc_verify_organizer(
    p_tournament_code TEXT,
    p_admin_token TEXT
) RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
    v_tournament_id UUID;
BEGIN
    SELECT id INTO v_tournament_id
    FROM public.tournaments
    WHERE tournament_code = upper(trim(p_tournament_code));

    IF v_tournament_id IS NULL THEN
        RETURN FALSE;
    END IF;

    RETURN public._verify_organizer(v_tournament_id, p_admin_token);
END;
$$;

-- ----------------------------------------------------------------------------
-- 8. RPC: Add Team & Players
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.rpc_add_team(
    p_tournament_code TEXT,
    p_admin_token TEXT,
    p_name TEXT,
    p_captain TEXT,
    p_players TEXT[]
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
    v_tournament_id UUID;
    v_status TEXT;
    v_teams_count INT;
    v_team_id UUID;
    v_player_name TEXT;
    v_order INT := 1;
BEGIN
    -- Look up tournament
    SELECT id, status INTO v_tournament_id, v_status
    FROM public.tournaments
    WHERE tournament_code = upper(trim(p_tournament_code));

    IF v_tournament_id IS NULL THEN
        RAISE EXCEPTION 'Tournament not found.';
    END IF;

    -- Verify organizer key
    IF NOT public._verify_organizer(v_tournament_id, p_admin_token) THEN
        RAISE EXCEPTION 'Invalid organizer key.';
    END IF;

    IF v_status <> 'registration' THEN
        RAISE EXCEPTION 'Cannot add teams once fixtures have started.';
    END IF;

    -- Validate team name
    IF trim(COALESCE(p_name, '')) = '' THEN
        RAISE EXCEPTION 'Team name is required.';
    END IF;

    -- Validate player count
    IF p_players IS NULL OR array_length(p_players, 1) IS NULL OR array_length(p_players, 1) < 6 THEN
        RAISE EXCEPTION 'Add at least six players for the team.';
    END IF;

    -- Check maximum teams limit
    SELECT count(*) INTO v_teams_count
    FROM public.teams
    WHERE tournament_id = v_tournament_id;

    IF v_teams_count >= 4 THEN
        RAISE EXCEPTION 'This tournament already has the maximum of four teams.';
    END IF;

    -- Check unique name
    IF EXISTS (
        SELECT 1 FROM public.teams
        WHERE tournament_id = v_tournament_id AND lower(name) = lower(trim(p_name))
    ) THEN
        RAISE EXCEPTION 'A team with this name already exists in this tournament.';
    END IF;

    -- Insert team
    INSERT INTO public.teams (
        tournament_id,
        name,
        captain
    ) VALUES (
        v_tournament_id,
        trim(p_name),
        nullif(trim(p_captain), '')
    ) RETURNING id INTO v_team_id;

    -- Insert players
    FOREACH v_player_name IN ARRAY p_players LOOP
        IF trim(COALESCE(v_player_name, '')) <> '' THEN
            INSERT INTO public.players (
                team_id,
                name,
                player_order
            ) VALUES (
                v_team_id,
                trim(v_player_name),
                v_order
            );
            v_order := v_order + 1;
        END IF;
    END LOOP;

    RETURN jsonb_build_object(
        'team_id', v_team_id,
        'tournament_id', v_tournament_id
    );
END;
$$;

-- ----------------------------------------------------------------------------
-- 9. RPC: Generate 6 Round-Robin League Fixtures
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.rpc_create_league_fixtures(
    p_tournament_code TEXT,
    p_admin_token TEXT
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
    v_tournament_id UUID;
    v_teams UUID[];
    v_team_count INT;
    v_existing_matches INT;
    v_pairs INT[][] := ARRAY[[1,2], [1,3], [1,4], [2,3], [2,4], [3,4]];
    v_i INT;
    v_team_a UUID;
    v_team_b UUID;
    v_match_id UUID;
BEGIN
    SELECT id INTO v_tournament_id
    FROM public.tournaments
    WHERE tournament_code = upper(trim(p_tournament_code));

    IF v_tournament_id IS NULL THEN
        RAISE EXCEPTION 'Tournament not found.';
    END IF;

    IF NOT public._verify_organizer(v_tournament_id, p_admin_token) THEN
        RAISE EXCEPTION 'Invalid organizer key.';
    END IF;

    -- Check teams count
    SELECT array_agg(id ORDER BY created_at ASC) INTO v_teams
    FROM public.teams
    WHERE tournament_id = v_tournament_id;

    v_team_count := COALESCE(array_length(v_teams, 1), 0);
    IF v_team_count <> 4 THEN
        RAISE EXCEPTION 'Add all four teams before generating fixtures (currently % of 4).', v_team_count;
    END IF;

    -- Check if league matches already exist
    SELECT count(*) INTO v_existing_matches
    FROM public.matches
    WHERE tournament_id = v_tournament_id AND stage = 'league';

    IF v_existing_matches > 0 THEN
        RAISE EXCEPTION 'League fixtures have already been generated.';
    END IF;

    -- Generate 6 round-robin matches
    FOR v_i IN 1..6 LOOP
        v_team_a := v_teams[v_pairs[v_i][1]];
        v_team_b := v_teams[v_pairs[v_i][2]];

        INSERT INTO public.matches (
            tournament_id,
            match_identifier,
            match_number,
            stage,
            round,
            team_a_id,
            team_b_id,
            status
        ) VALUES (
            v_tournament_id,
            'league_' || v_i,
            v_i,
            'league',
            'League',
            v_team_a,
            v_team_b,
            'upcoming'
        );
    END LOOP;

    -- Update tournament status
    UPDATE public.tournaments
    SET status = 'league', updated_at = now()
    WHERE id = v_tournament_id;

    RETURN jsonb_build_object(
        'tournament_id', v_tournament_id,
        'match_count', 6
    );
END;
$$;

-- ----------------------------------------------------------------------------
-- 10. RPC: Update Match Score (Strict Volleyball Rules Enforcement)
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.rpc_update_match_score(
    p_tournament_code TEXT,
    p_admin_token TEXT,
    p_match_identifier TEXT,
    p_sets JSONB
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
    v_tournament_id UUID;
    v_match_id UUID;
    v_team_a_id UUID;
    v_team_b_id UUID;
    v_team_a_name TEXT;
    v_team_b_name TEXT;
    v_current_status TEXT;
    v_set_count INT;
    v_i INT;
    v_set JSONB;
    v_a INT;
    v_b INT;
    v_target INT;
    v_wins_a INT := 0;
    v_wins_b INT := 0;
    v_is_finished BOOLEAN := FALSE;
    v_winner_id UUID := NULL;
    v_winner_name TEXT := NULL;
    v_new_status TEXT;
BEGIN
    SELECT id INTO v_tournament_id
    FROM public.tournaments
    WHERE tournament_code = upper(trim(p_tournament_code));

    IF v_tournament_id IS NULL THEN
        RAISE EXCEPTION 'Tournament not found.';
    END IF;

    IF NOT public._verify_organizer(v_tournament_id, p_admin_token) THEN
        RAISE EXCEPTION 'Invalid organizer key.';
    END IF;

    -- Retrieve match
    SELECT m.id, m.team_a_id, m.team_b_id, m.status, ta.name, tb.name
    INTO v_match_id, v_team_a_id, v_team_b_id, v_current_status, v_team_a_name, v_team_b_name
    FROM public.matches m
    LEFT JOIN public.teams ta ON ta.id = m.team_a_id
    LEFT JOIN public.teams tb ON tb.id = m.team_b_id
    WHERE m.tournament_id = v_tournament_id AND m.match_identifier = trim(p_match_identifier);

    IF v_match_id IS NULL THEN
        RAISE EXCEPTION 'Match % not found.', p_match_identifier;
    END IF;

    IF v_team_a_id IS NULL OR v_team_b_id IS NULL THEN
        RAISE EXCEPTION 'Match participants are not yet determined.';
    END IF;

    -- Validate sets json array
    IF jsonb_typeof(p_sets) <> 'array' THEN
        RAISE EXCEPTION 'Sets must be provided as a JSON array.';
    END IF;

    v_set_count := jsonb_array_length(p_sets);
    IF v_set_count < 1 OR v_set_count > 3 THEN
        RAISE EXCEPTION 'Volleyball matches consist of 1 to 3 sets.';
    END IF;

    -- Enforce volleyball scoring rules set by set
    FOR v_i IN 0..(v_set_count - 1) LOOP
        v_set := p_sets->v_i;
        v_a := COALESCE((v_set->>'a')::int, 0);
        v_b := COALESCE((v_set->>'b')::int, 0);

        IF v_a < 0 OR v_b < 0 THEN
            RAISE EXCEPTION 'Set scores cannot be negative.';
        END IF;

        IF v_a = v_b THEN
            RAISE EXCEPTION 'Set % cannot end in a tie (% - %).', (v_i + 1), v_a, v_b;
        END IF;

        -- Target: first 2 sets are 25 points, 3rd deciding set is 15 points
        v_target := CASE WHEN v_i = 2 THEN 15 ELSE 25 END;

        -- Win by 2 points rule:
        -- To win a set, a team must reach at least the target AND lead by at least 2
        IF v_a > v_b THEN
            IF v_a < v_target OR (v_a - v_b) < 2 THEN
                RAISE EXCEPTION 'Set % invalid: Winner must reach at least % points and win by at least 2 points (entered % - %).',
                    (v_i + 1), v_target, v_a, v_b;
            END IF;
            v_wins_a := v_wins_a + 1;
        ELSE
            IF v_b < v_target OR (v_b - v_a) < 2 THEN
                RAISE EXCEPTION 'Set % invalid: Winner must reach at least % points and win by at least 2 points (entered % - %).',
                    (v_i + 1), v_target, v_a, v_b;
            END IF;
            v_wins_b := v_wins_b + 1;
        END IF;

        -- If a team already won 2 sets before the last entered set, reject extra sets
        IF (v_wins_a = 2 OR v_wins_b = 2) AND (v_i + 1 < v_set_count) THEN
            RAISE EXCEPTION 'A best-of-three match ends when a team wins 2 sets. Remove scores entered after the winning set.';
        END IF;
    END LOOP;

    v_is_finished := (v_wins_a = 2 OR v_wins_b = 2);

    IF v_is_finished THEN
        v_new_status := 'completed';
        IF v_wins_a = 2 THEN
            v_winner_id := v_team_a_id;
            v_winner_name := v_team_a_name;
        ELSE
            v_winner_id := v_team_b_id;
            v_winner_name := v_team_b_name;
        END IF;
    ELSE
        -- 1 set played without a decisive 2-set winner
        v_new_status := 'live';
        v_winner_id := NULL;
        v_winner_name := NULL;
    END IF;

    -- Replace match sets
    DELETE FROM public.match_sets WHERE match_id = v_match_id;

    FOR v_i IN 0..(v_set_count - 1) LOOP
        v_set := p_sets->v_i;
        INSERT INTO public.match_sets (
            match_id,
            set_number,
            team_a_points,
            team_b_points
        ) VALUES (
            v_match_id,
            (v_i + 1),
            (v_set->>'a')::int,
            (v_set->>'b')::int
        );
    END LOOP;

    -- Update match record
    UPDATE public.matches
    SET status = v_new_status,
        winner_id = v_winner_id,
        winner_name = v_winner_name,
        updated_at = now()
    WHERE id = v_match_id;

    RETURN jsonb_build_object(
        'status', v_new_status,
        'winner_id', v_winner_id,
        'winner_name', v_winner_name
    );
END;
$$;

-- ----------------------------------------------------------------------------
-- 11. RPC: Create Knockout Fixtures (Semifinals)
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.rpc_create_knockout_fixtures(
    p_tournament_code TEXT,
    p_admin_token TEXT
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
    v_tournament_id UUID;
    v_completed_league_count INT;
    v_existing_knockout INT;
    v_standings RECORD;
    v_ranked_teams UUID[];
    v_ranked_names TEXT[];
BEGIN
    SELECT id INTO v_tournament_id
    FROM public.tournaments
    WHERE tournament_code = upper(trim(p_tournament_code));

    IF v_tournament_id IS NULL THEN
        RAISE EXCEPTION 'Tournament not found.';
    END IF;

    IF NOT public._verify_organizer(v_tournament_id, p_admin_token) THEN
        RAISE EXCEPTION 'Invalid organizer key.';
    END IF;

    -- Ensure all 6 league matches are completed
    SELECT count(*) INTO v_completed_league_count
    FROM public.matches
    WHERE tournament_id = v_tournament_id AND stage = 'league' AND status = 'completed';

    IF v_completed_league_count <> 6 THEN
        RAISE EXCEPTION 'All six league matches must be completed before generating semi-finals (currently %/6 completed).', v_completed_league_count;
    END IF;

    -- Ensure knockout fixtures do not already exist
    SELECT count(*) INTO v_existing_knockout
    FROM public.matches
    WHERE tournament_id = v_tournament_id AND stage = 'knockout';

    IF v_existing_knockout > 0 THEN
        RAISE EXCEPTION 'Knockout fixtures already exist.';
    END IF;

    -- Compute Standings using strict volleyball rules:
    -- Win 2-0: 3 pts
    -- Win 2-1: 2 pts
    -- Loss 1-2: 1 pt
    -- Loss 0-2: 0 pts
    -- Tie-breaker: Points DESC, then (Sets For - Sets Against) differential DESC
    WITH team_list AS (
        SELECT id, name FROM public.teams WHERE tournament_id = v_tournament_id
    ),
    match_data AS (
        SELECT
            m.id,
            m.team_a_id,
            m.team_b_id,
            m.winner_id,
            count(*) FILTER (WHERE ms.team_a_points > ms.team_b_points) AS sets_a,
            count(*) FILTER (WHERE ms.team_b_points > ms.team_a_points) AS sets_b
        FROM public.matches m
        JOIN public.match_sets ms ON ms.match_id = m.id
        WHERE m.tournament_id = v_tournament_id AND m.stage = 'league'
        GROUP BY m.id, m.team_a_id, m.team_b_id, m.winner_id
    ),
    team_points AS (
        SELECT
            t.id,
            t.name,
            COALESCE(SUM(
                CASE
                    -- Team A won 2-0 -> 3 pts; won 2-1 -> 2 pts
                    WHEN md.team_a_id = t.id AND md.sets_a = 2 AND md.sets_b = 0 THEN 3
                    WHEN md.team_a_id = t.id AND md.sets_a = 2 AND md.sets_b = 1 THEN 2
                    -- Team A lost 1-2 -> 1 pt; lost 0-2 -> 0 pts
                    WHEN md.team_a_id = t.id AND md.sets_a = 1 AND md.sets_b = 2 THEN 1
                    -- Team B won 2-0 -> 3 pts; won 2-1 -> 2 pts
                    WHEN md.team_b_id = t.id AND md.sets_b = 2 AND md.sets_a = 0 THEN 3
                    WHEN md.team_b_id = t.id AND md.sets_b = 2 AND md.sets_a = 1 THEN 2
                    -- Team B lost 1-2 -> 1 pt; lost 0-2 -> 0 pts
                    WHEN md.team_b_id = t.id AND md.sets_b = 1 AND md.sets_a = 2 THEN 1
                    ELSE 0
                END
            ), 0) AS points,
            COALESCE(SUM(
                CASE
                    WHEN md.team_a_id = t.id THEN md.sets_a
                    WHEN md.team_b_id = t.id THEN md.sets_b
                    ELSE 0
                END
            ), 0) AS sets_for,
            COALESCE(SUM(
                CASE
                    WHEN md.team_a_id = t.id THEN md.sets_b
                    WHEN md.team_b_id = t.id THEN md.sets_a
                    ELSE 0
                END
            ), 0) AS sets_against
        FROM team_list t
        LEFT JOIN match_data md ON md.team_a_id = t.id OR md.team_b_id = t.id
        GROUP BY t.id, t.name
    )
    SELECT
        array_agg(id ORDER BY points DESC, (sets_for - sets_against) DESC),
        array_agg(name ORDER BY points DESC, (sets_for - sets_against) DESC)
    INTO v_ranked_teams, v_ranked_names
    FROM team_points;

    -- Create Semi-final 1: Rank 1 vs Rank 4 (Match 7)
    INSERT INTO public.matches (
        tournament_id,
        match_identifier,
        match_number,
        stage,
        round,
        team_a_id,
        team_b_id,
        status
    ) VALUES (
        v_tournament_id,
        'semi_1',
        7,
        'knockout',
        'Semi-final 1',
        v_ranked_teams[1],
        v_ranked_teams[4],
        'upcoming'
    );

    -- Create Semi-final 2: Rank 2 vs Rank 3 (Match 8)
    INSERT INTO public.matches (
        tournament_id,
        match_identifier,
        match_number,
        stage,
        round,
        team_a_id,
        team_b_id,
        status
    ) VALUES (
        v_tournament_id,
        'semi_2',
        8,
        'knockout',
        'Semi-final 2',
        v_ranked_teams[2],
        v_ranked_teams[3],
        'upcoming'
    );

    -- Update tournament status
    UPDATE public.tournaments
    SET status = 'knockout', updated_at = now()
    WHERE id = v_tournament_id;

    RETURN jsonb_build_object(
        'tournament_id', v_tournament_id,
        'semifinals', jsonb_build_array(
            jsonb_build_object('match', 'semi_1', 'team_a', v_ranked_names[1], 'team_b', v_ranked_names[4]),
            jsonb_build_object('match', 'semi_2', 'team_a', v_ranked_names[2], 'team_b', v_ranked_names[3])
        )
    );
END;
$$;

-- ----------------------------------------------------------------------------
-- 12. RPC: Create Final
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.rpc_create_final(
    p_tournament_code TEXT,
    p_admin_token TEXT
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
    v_tournament_id UUID;
    v_semi_1_winner UUID;
    v_semi_2_winner UUID;
    v_semi_1_status TEXT;
    v_semi_2_status TEXT;
    v_existing_final INT;
BEGIN
    SELECT id INTO v_tournament_id
    FROM public.tournaments
    WHERE tournament_code = upper(trim(p_tournament_code));

    IF v_tournament_id IS NULL THEN
        RAISE EXCEPTION 'Tournament not found.';
    END IF;

    IF NOT public._verify_organizer(v_tournament_id, p_admin_token) THEN
        RAISE EXCEPTION 'Invalid organizer key.';
    END IF;

    -- Verify both semifinals are completed
    SELECT winner_id, status INTO v_semi_1_winner, v_semi_1_status
    FROM public.matches
    WHERE tournament_id = v_tournament_id AND match_identifier = 'semi_1';

    SELECT winner_id, status INTO v_semi_2_winner, v_semi_2_status
    FROM public.matches
    WHERE tournament_id = v_tournament_id AND match_identifier = 'semi_2';

    IF v_semi_1_winner IS NULL OR v_semi_1_status <> 'completed' OR
       v_semi_2_winner IS NULL OR v_semi_2_status <> 'completed' THEN
        RAISE EXCEPTION 'Both semi-finals must be completed before creating the final.';
    END IF;

    -- Check if final already exists
    SELECT count(*) INTO v_existing_final
    FROM public.matches
    WHERE tournament_id = v_tournament_id AND match_identifier = 'final';

    IF v_existing_final > 0 THEN
        RAISE EXCEPTION 'The final match has already been created.';
    END IF;

    -- Create Final Match (Match 9)
    INSERT INTO public.matches (
        tournament_id,
        match_identifier,
        match_number,
        stage,
        round,
        team_a_id,
        team_b_id,
        status
    ) VALUES (
        v_tournament_id,
        'final',
        9,
        'knockout',
        'Final',
        v_semi_1_winner,
        v_semi_2_winner,
        'upcoming'
    );

    UPDATE public.tournaments
    SET status = 'final', updated_at = now()
    WHERE id = v_tournament_id;

    RETURN jsonb_build_object(
        'tournament_id', v_tournament_id,
        'ok', true
    );
END;
$$;

-- ----------------------------------------------------------------------------
-- 13. RPC: Set Tournament Winner
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.rpc_set_tournament_winner(
    p_tournament_code TEXT,
    p_admin_token TEXT
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
    v_tournament_id UUID;
    v_final_status TEXT;
    v_winner_id UUID;
    v_winner_name TEXT;
BEGIN
    SELECT id INTO v_tournament_id
    FROM public.tournaments
    WHERE tournament_code = upper(trim(p_tournament_code));

    IF v_tournament_id IS NULL THEN
        RAISE EXCEPTION 'Tournament not found.';
    END IF;

    IF NOT public._verify_organizer(v_tournament_id, p_admin_token) THEN
        RAISE EXCEPTION 'Invalid organizer key.';
    END IF;

    -- Check final match
    SELECT status, winner_id, winner_name
    INTO v_final_status, v_winner_id, v_winner_name
    FROM public.matches
    WHERE tournament_id = v_tournament_id AND match_identifier = 'final';

    IF v_final_status IS NULL OR v_final_status <> 'completed' OR v_winner_id IS NULL THEN
        RAISE EXCEPTION 'The final match must be completed first.';
    END IF;

    -- Update tournament winner and completed status
    UPDATE public.tournaments
    SET status = 'completed',
        winner_id = v_winner_id,
        winner_name = v_winner_name,
        updated_at = now()
    WHERE id = v_tournament_id;

    RETURN jsonb_build_object(
        'winner_id', v_winner_id,
        'winner_name', v_winner_name
    );
END;
$$;

-- Grant execute permissions to anon and authenticated users on public RPC functions
GRANT EXECUTE ON FUNCTION public.rpc_create_tournament TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rpc_verify_organizer TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rpc_add_team TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rpc_create_league_fixtures TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rpc_update_match_score TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rpc_create_knockout_fixtures TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rpc_create_final TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rpc_set_tournament_winner TO anon, authenticated;
