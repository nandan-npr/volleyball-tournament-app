-- ============================================================================
-- VolleyLive Migration: Enhanced Team Roster, Manual Matches & Scoring
-- File: supabase/migrations/20261107000001_organizer_management_and_scoring.sql
-- ============================================================================

-- 1. Schema Extensions
-- Add is_starter flag to players table
ALTER TABLE public.players 
ADD COLUMN IF NOT EXISTS is_starter BOOLEAN NOT NULL DEFAULT false;

-- Add scheduled_time and is_manual flag to matches table
ALTER TABLE public.matches 
ADD COLUMN IF NOT EXISTS scheduled_time TEXT,
ADD COLUMN IF NOT EXISTS is_manual BOOLEAN NOT NULL DEFAULT false;

-- Ensure default 6 starting players for any existing rosters
UPDATE public.players p
SET is_starter = true
FROM (
    SELECT id, row_number() OVER (PARTITION BY team_id ORDER BY player_order ASC, created_at ASC) as rn
    FROM public.players
) sub
WHERE p.id = sub.id AND sub.rn <= 6;

-- ----------------------------------------------------------------------------
-- 2. RPC: Update Team Details (Name and Captain)
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.rpc_update_team(
    p_tournament_code TEXT,
    p_admin_token TEXT,
    p_team_id UUID,
    p_name TEXT,
    p_captain TEXT
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
    v_tournament_id UUID;
    v_clean_name TEXT := trim(COALESCE(p_name, ''));
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

    IF v_clean_name = '' THEN
        RAISE EXCEPTION 'Team name cannot be empty.';
    END IF;

    -- Check for duplicate team name within tournament (excluding current team)
    IF EXISTS (
        SELECT 1 FROM public.teams
        WHERE tournament_id = v_tournament_id 
          AND id <> p_team_id 
          AND lower(name) = lower(v_clean_name)
    ) THEN
        RAISE EXCEPTION 'Another team with this name already exists.';
    END IF;

    UPDATE public.teams
    SET name = v_clean_name,
        captain = nullif(trim(p_captain), '')
    WHERE id = p_team_id AND tournament_id = v_tournament_id;

    RETURN jsonb_build_object('success', true);
END;
$$;

-- ----------------------------------------------------------------------------
-- 3. RPC: Delete Team (Guarded against active tournaments)
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.rpc_delete_team(
    p_tournament_code TEXT,
    p_admin_token TEXT,
    p_team_id UUID
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
    v_tournament_id UUID;
    v_match_count INT;
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

    -- Safety check: Disallow deleting team if matches have already been generated/scheduled
    SELECT count(*) INTO v_match_count
    FROM public.matches
    WHERE tournament_id = v_tournament_id 
      AND (team_a_id = p_team_id OR team_b_id = p_team_id);

    IF v_match_count > 0 THEN
        RAISE EXCEPTION 'Cannot delete team because matches involving this team have already been scheduled or played.';
    END IF;

    DELETE FROM public.teams
    WHERE id = p_team_id AND tournament_id = v_tournament_id;

    RETURN jsonb_build_object('success', true);
END;
$$;

-- ----------------------------------------------------------------------------
-- 4. RPC: Add Player to Team
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.rpc_add_player(
    p_tournament_code TEXT,
    p_admin_token TEXT,
    p_team_id UUID,
    p_player_name TEXT,
    p_is_starter BOOLEAN DEFAULT false
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
    v_tournament_id UUID;
    v_order INT;
    v_player_id UUID;
    v_starter_count INT;
    v_clean_name TEXT := trim(COALESCE(p_player_name, ''));
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

    IF v_clean_name = '' THEN
        RAISE EXCEPTION 'Player name cannot be empty.';
    END IF;

    -- Verify team belongs to tournament
    IF NOT EXISTS (SELECT 1 FROM public.teams WHERE id = p_team_id AND tournament_id = v_tournament_id) THEN
        RAISE EXCEPTION 'Team does not belong to this tournament.';
    END IF;

    -- Count existing starters if marking as starter
    IF p_is_starter THEN
        SELECT count(*) INTO v_starter_count
        FROM public.players
        WHERE team_id = p_team_id AND is_starter = true;

        IF v_starter_count >= 6 THEN
            RAISE EXCEPTION 'A volleyball team can have at most 6 starting players. Please adjust existing starters first.';
        END IF;
    END IF;

    SELECT COALESCE(MAX(player_order), 0) + 1 INTO v_order
    FROM public.players
    WHERE team_id = p_team_id;

    INSERT INTO public.players (
        team_id,
        name,
        player_order,
        is_starter
    ) VALUES (
        p_team_id,
        v_clean_name,
        v_order,
        COALESCE(p_is_starter, false)
    ) RETURNING id INTO v_player_id;

    RETURN jsonb_build_object(
        'player_id', v_player_id,
        'team_id', p_team_id,
        'name', v_clean_name,
        'is_starter', COALESCE(p_is_starter, false)
    );
END;
$$;

-- ----------------------------------------------------------------------------
-- 5. RPC: Update Player (Name & Starter Status)
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.rpc_update_player(
    p_tournament_code TEXT,
    p_admin_token TEXT,
    p_player_id UUID,
    p_player_name TEXT,
    p_is_starter BOOLEAN
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
    v_tournament_id UUID;
    v_team_id UUID;
    v_clean_name TEXT := trim(COALESCE(p_player_name, ''));
    v_starter_count INT;
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

    IF v_clean_name = '' THEN
        RAISE EXCEPTION 'Player name cannot be empty.';
    END IF;

    SELECT team_id INTO v_team_id
    FROM public.players
    WHERE id = p_player_id;

    IF v_team_id IS NULL THEN
        RAISE EXCEPTION 'Player not found.';
    END IF;

    IF NOT EXISTS (SELECT 1 FROM public.teams WHERE id = v_team_id AND tournament_id = v_tournament_id) THEN
        RAISE EXCEPTION 'Player does not belong to this tournament.';
    END IF;

    IF p_is_starter THEN
        SELECT count(*) INTO v_starter_count
        FROM public.players
        WHERE team_id = v_team_id AND is_starter = true AND id <> p_player_id;

        IF v_starter_count >= 6 THEN
            RAISE EXCEPTION 'A team cannot have more than 6 starting players.';
        END IF;
    END IF;

    UPDATE public.players
    SET name = v_clean_name,
        is_starter = COALESCE(p_is_starter, is_starter)
    WHERE id = p_player_id;

    RETURN jsonb_build_object('success', true);
END;
$$;

-- ----------------------------------------------------------------------------
-- 6. RPC: Delete Player
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.rpc_delete_player(
    p_tournament_code TEXT,
    p_admin_token TEXT,
    p_player_id UUID
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
    v_tournament_id UUID;
    v_team_id UUID;
    v_player_count INT;
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

    SELECT team_id INTO v_team_id
    FROM public.players
    WHERE id = p_player_id;

    IF v_team_id IS NULL THEN
        RAISE EXCEPTION 'Player not found.';
    END IF;

    SELECT count(*) INTO v_player_count
    FROM public.players
    WHERE team_id = v_team_id;

    IF v_player_count <= 6 THEN
        RAISE EXCEPTION 'Cannot delete player. A volleyball team requires a minimum of 6 players.';
    END IF;

    DELETE FROM public.players WHERE id = p_player_id;

    RETURN jsonb_build_object('success', true);
END;
$$;

-- ----------------------------------------------------------------------------
-- 7. RPC: Set Starters for Team (Select Exactly 6 Starting Players)
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.rpc_set_starters(
    p_tournament_code TEXT,
    p_admin_token TEXT,
    p_team_id UUID,
    p_starter_ids UUID[]
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
    v_tournament_id UUID;
    v_count INT;
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

    IF p_starter_ids IS NULL OR array_length(p_starter_ids, 1) <> 6 THEN
        RAISE EXCEPTION 'Exactly 6 starting players must be designated.';
    END IF;

    -- Verify all IDs belong to this team
    SELECT count(*) INTO v_count
    FROM public.players
    WHERE team_id = p_team_id AND id = ANY(p_starter_ids);

    IF v_count <> 6 THEN
        RAISE EXCEPTION 'All 6 designated starting players must belong to this team.';
    END IF;

    -- Reset all to false, then set designated to true
    UPDATE public.players
    SET is_starter = (id = ANY(p_starter_ids))
    WHERE team_id = p_team_id;

    RETURN jsonb_build_object('success', true);
END;
$$;

-- ----------------------------------------------------------------------------
-- 8. RPC: Create Manual Match
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.rpc_create_manual_match(
    p_tournament_code TEXT,
    p_admin_token TEXT,
    p_team_a_id UUID,
    p_team_b_id UUID,
    p_stage TEXT,
    p_round TEXT,
    p_match_number INT,
    p_scheduled_time TEXT DEFAULT NULL
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
    v_tournament_id UUID;
    v_identifier TEXT;
    v_match_id UUID;
    v_clean_stage TEXT := lower(trim(COALESCE(p_stage, 'league')));
    v_clean_round TEXT := trim(COALESCE(p_round, 'Match ' || p_match_number));
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

    -- Validate distinct teams
    IF p_team_a_id IS NULL OR p_team_b_id IS NULL THEN
        RAISE EXCEPTION 'Both Team A and Team B must be selected.';
    END IF;

    IF p_team_a_id = p_team_b_id THEN
        RAISE EXCEPTION 'Team A and Team B cannot be the same team.';
    END IF;

    -- Verify both teams belong to tournament
    IF NOT EXISTS (SELECT 1 FROM public.teams WHERE id = p_team_a_id AND tournament_id = v_tournament_id) OR
       NOT EXISTS (SELECT 1 FROM public.teams WHERE id = p_team_b_id AND tournament_id = v_tournament_id) THEN
        RAISE EXCEPTION 'Selected teams must belong to this tournament.';
    END IF;

    -- Validate stage
    IF v_clean_stage NOT IN ('league', 'knockout') THEN
        v_clean_stage := 'league';
    END IF;

    -- Generate a unique match identifier
    v_identifier := 'custom_' || p_match_number || '_' || substr(md5(random()::text), 1, 6);

    -- Check match number uniqueness
    IF EXISTS (SELECT 1 FROM public.matches WHERE tournament_id = v_tournament_id AND match_number = p_match_number) THEN
        RAISE EXCEPTION 'A match with number % already exists in this tournament.', p_match_number;
    END IF;

    INSERT INTO public.matches (
        tournament_id,
        match_identifier,
        match_number,
        stage,
        round,
        team_a_id,
        team_b_id,
        status,
        scheduled_time,
        is_manual
    ) VALUES (
        v_tournament_id,
        v_identifier,
        p_match_number,
        v_clean_stage,
        v_clean_round,
        p_team_a_id,
        p_team_b_id,
        'upcoming',
        nullif(trim(p_scheduled_time), ''),
        true
    ) RETURNING id INTO v_match_id;

    RETURN jsonb_build_object(
        'match_id', v_match_id,
        'match_identifier', v_identifier,
        'match_number', p_match_number
    );
END;
$$;

-- ----------------------------------------------------------------------------
-- 9. RPC: Update Match Score with Optional Authorized Correction Workflow
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.rpc_update_match_score(
    p_tournament_code TEXT,
    p_admin_token TEXT,
    p_match_identifier TEXT,
    p_sets JSONB,
    p_allow_completed_edit BOOLEAN DEFAULT false
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

    SELECT m.id, m.team_a_id, m.team_b_id, m.status, ta.name, tb.name
    INTO v_match_id, v_team_a_id, v_team_b_id, v_current_status, v_team_a_name, v_team_b_name
    FROM public.matches m
    LEFT JOIN public.teams ta ON ta.id = m.team_a_id
    LEFT JOIN public.teams tb ON tb.id = m.team_b_id
    WHERE m.tournament_id = v_tournament_id AND m.match_identifier = trim(p_match_identifier);

    IF v_match_id IS NULL THEN
        RAISE EXCEPTION 'Match % not found.', p_match_identifier;
    END IF;

    -- Rejection of completed match unless explicit authorized correction workflow requested
    IF v_current_status = 'completed' AND NOT COALESCE(p_allow_completed_edit, false) THEN
        RAISE EXCEPTION 'Cannot update scores for a match that is already completed. Use authorized correction mode if a score error was made.';
    END IF;

    IF v_team_a_id IS NULL OR v_team_b_id IS NULL THEN
        RAISE EXCEPTION 'Match participants are not yet determined.';
    END IF;

    IF jsonb_typeof(p_sets) <> 'array' THEN
        RAISE EXCEPTION 'Sets must be provided as a JSON array.';
    END IF;

    v_set_count := jsonb_array_length(p_sets);
    IF v_set_count < 1 OR v_set_count > 3 THEN
        RAISE EXCEPTION 'Volleyball matches consist of 1 to 3 sets.';
    END IF;

    -- Validate each set according to volleyball rules
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

        -- Target: first 2 sets are 25 points, deciding 3rd set is 15 points
        v_target := CASE WHEN v_i = 2 THEN 15 ELSE 25 END;

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
        v_new_status := 'live';
        v_winner_id := NULL;
        v_winner_name := NULL;
    END IF;

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
-- 10. UUID-Based Overload Functions (Seamless Dual-Signature Support)
-- ----------------------------------------------------------------------------

-- Overload: rpc_create_manual_match by UUID
CREATE OR REPLACE FUNCTION public.rpc_create_manual_match(
    p_admin_token TEXT,
    p_tournament_id UUID,
    p_team1_id UUID,
    p_team2_id UUID,
    p_stage TEXT,
    p_match_number INT,
    p_scheduled_time TEXT DEFAULT NULL
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
    v_code TEXT;
BEGIN
    SELECT tournament_code INTO v_code FROM public.tournaments WHERE id = p_tournament_id;
    IF v_code IS NULL THEN
        RAISE EXCEPTION 'Tournament not found.';
    END IF;

    RETURN public.rpc_create_manual_match(
        v_code,
        p_admin_token,
        p_team1_id,
        p_team2_id,
        p_stage,
        (p_stage || ' Match ' || p_match_number),
        p_match_number,
        p_scheduled_time
    );
END;
$$;

-- Overload: rpc_update_team by UUID
CREATE OR REPLACE FUNCTION public.rpc_update_team(
    p_admin_token TEXT,
    p_team_id UUID,
    p_name TEXT,
    p_captain TEXT
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
    v_code TEXT;
BEGIN
    SELECT t.tournament_code INTO v_code
    FROM public.teams tm
    JOIN public.tournaments t ON tm.tournament_id = t.id
    WHERE tm.id = p_team_id;

    IF v_code IS NULL THEN
        RAISE EXCEPTION 'Team not found.';
    END IF;

    RETURN public.rpc_update_team(v_code, p_admin_token, p_team_id, p_name, p_captain);
END;
$$;

-- Overload: rpc_delete_team by UUID
CREATE OR REPLACE FUNCTION public.rpc_delete_team(
    p_admin_token TEXT,
    p_team_id UUID
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
    v_code TEXT;
BEGIN
    SELECT t.tournament_code INTO v_code
    FROM public.teams tm
    JOIN public.tournaments t ON tm.tournament_id = t.id
    WHERE tm.id = p_team_id;

    IF v_code IS NULL THEN
        RAISE EXCEPTION 'Team not found.';
    END IF;

    RETURN public.rpc_delete_team(v_code, p_admin_token, p_team_id);
END;
$$;

-- Overload: rpc_add_player by UUID
CREATE OR REPLACE FUNCTION public.rpc_add_player(
    p_admin_token TEXT,
    p_team_id UUID,
    p_name TEXT,
    p_is_starter BOOLEAN DEFAULT false
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
    v_code TEXT;
BEGIN
    SELECT t.tournament_code INTO v_code
    FROM public.teams tm
    JOIN public.tournaments t ON tm.tournament_id = t.id
    WHERE tm.id = p_team_id;

    IF v_code IS NULL THEN
        RAISE EXCEPTION 'Team not found.';
    END IF;

    RETURN public.rpc_add_player(v_code, p_admin_token, p_team_id, p_name, p_is_starter);
END;
$$;

-- Overload: rpc_update_player by UUID
CREATE OR REPLACE FUNCTION public.rpc_update_player(
    p_admin_token TEXT,
    p_player_id UUID,
    p_name TEXT,
    p_is_starter BOOLEAN
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
    v_code TEXT;
BEGIN
    SELECT t.tournament_code INTO v_code
    FROM public.players p
    JOIN public.teams tm ON p.team_id = tm.id
    JOIN public.tournaments t ON tm.tournament_id = t.id
    WHERE p.id = p_player_id;

    IF v_code IS NULL THEN
        RAISE EXCEPTION 'Player not found.';
    END IF;

    RETURN public.rpc_update_player(v_code, p_admin_token, p_player_id, p_name, p_is_starter);
END;
$$;

-- Overload: rpc_delete_player by UUID
CREATE OR REPLACE FUNCTION public.rpc_delete_player(
    p_admin_token TEXT,
    p_player_id UUID
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
    v_code TEXT;
BEGIN
    SELECT t.tournament_code INTO v_code
    FROM public.players p
    JOIN public.teams tm ON p.team_id = tm.id
    JOIN public.tournaments t ON tm.tournament_id = t.id
    WHERE p.id = p_player_id;

    IF v_code IS NULL THEN
        RAISE EXCEPTION 'Player not found.';
    END IF;

    RETURN public.rpc_delete_player(v_code, p_admin_token, p_player_id);
END;
$$;

-- Overload: rpc_set_starters by UUID
CREATE OR REPLACE FUNCTION public.rpc_set_starters(
    p_admin_token TEXT,
    p_team_id UUID,
    p_starter_ids UUID[]
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
    v_code TEXT;
BEGIN
    SELECT t.tournament_code INTO v_code
    FROM public.teams tm
    JOIN public.tournaments t ON tm.tournament_id = t.id
    WHERE tm.id = p_team_id;

    IF v_code IS NULL THEN
        RAISE EXCEPTION 'Team not found.';
    END IF;

    RETURN public.rpc_set_starters(v_code, p_admin_token, p_team_id, p_starter_ids);
END;
$$;

-- Overload: rpc_update_match_score by match UUID
CREATE OR REPLACE FUNCTION public.rpc_update_match_score(
    p_admin_token TEXT,
    p_match_id UUID,
    p_set1_t1 INT,
    p_set1_t2 INT,
    p_set2_t1 INT DEFAULT NULL,
    p_set2_t2 INT DEFAULT NULL,
    p_set3_t1 INT DEFAULT NULL,
    p_set3_t2 INT DEFAULT NULL,
    p_allow_completed_edit BOOLEAN DEFAULT false
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
    v_code TEXT;
    v_ident TEXT;
    v_sets JSONB := '[]'::jsonb;
BEGIN
    SELECT t.tournament_code, m.match_identifier
    INTO v_code, v_ident
    FROM public.matches m
    JOIN public.tournaments t ON m.tournament_id = t.id
    WHERE m.id = p_match_id;

    IF v_code IS NULL THEN
        RAISE EXCEPTION 'Match not found.';
    END IF;

    IF p_set1_t1 IS NOT NULL AND p_set1_t2 IS NOT NULL THEN
        v_sets := v_sets || jsonb_build_object('a', p_set1_t1, 'b', p_set1_t2);
    END IF;

    IF p_set2_t1 IS NOT NULL AND p_set2_t2 IS NOT NULL THEN
        v_sets := v_sets || jsonb_build_object('a', p_set2_t1, 'b', p_set2_t2);
    END IF;

    IF p_set3_t1 IS NOT NULL AND p_set3_t2 IS NOT NULL THEN
        v_sets := v_sets || jsonb_build_object('a', p_set3_t1, 'b', p_set3_t2);
    END IF;

    RETURN public.rpc_update_match_score(
        v_code,
        p_admin_token,
        v_ident,
        v_sets,
        p_allow_completed_edit
    );
END;
$$;

-- Grant execution permissions on all RPCs
GRANT EXECUTE ON FUNCTION public.rpc_update_team(TEXT, TEXT, UUID, TEXT, TEXT) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rpc_update_team(TEXT, UUID, TEXT, TEXT) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rpc_delete_team(TEXT, TEXT, UUID) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rpc_delete_team(TEXT, UUID) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rpc_add_player(TEXT, TEXT, UUID, TEXT, BOOLEAN) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rpc_add_player(TEXT, UUID, TEXT, BOOLEAN) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rpc_update_player(TEXT, TEXT, UUID, TEXT, BOOLEAN) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rpc_update_player(TEXT, UUID, TEXT, BOOLEAN) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rpc_delete_player(TEXT, TEXT, UUID) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rpc_delete_player(TEXT, UUID) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rpc_set_starters(TEXT, TEXT, UUID, UUID[]) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rpc_set_starters(TEXT, UUID, UUID[]) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rpc_create_manual_match(TEXT, TEXT, UUID, UUID, TEXT, TEXT, INT, TEXT) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rpc_create_manual_match(TEXT, UUID, UUID, UUID, TEXT, INT, TEXT) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rpc_update_match_score(TEXT, TEXT, TEXT, JSONB, BOOLEAN) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rpc_update_match_score(TEXT, UUID, INT, INT, INT, INT, INT, INT, BOOLEAN) TO anon, authenticated;
