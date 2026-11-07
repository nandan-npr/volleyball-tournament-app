-- ============================================================================
-- VolleyLive Security & Rule Enforcement Patch
-- Execute this patch once in your Supabase SQL Editor.
-- ============================================================================

-- 1. Restrict internal verification function execution from public access
-- Prevents direct client invocation via PostgREST /rpc while allowing internal SECURITY DEFINER functions to call it.
REVOKE ALL ON FUNCTION public._verify_organizer(uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public._verify_organizer(uuid, text) TO postgres, service_role;

-- 2. Revoke all direct privileges on private organizer credentials table
REVOKE ALL ON TABLE public.organizer_credentials FROM PUBLIC, anon, authenticated;

-- 3. Replace rpc_update_match_score to strictly reject updates to completed matches
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
    -- Verify tournament exists
    SELECT id INTO v_tournament_id
    FROM public.tournaments
    WHERE tournament_code = upper(trim(p_tournament_code));

    IF v_tournament_id IS NULL THEN
        RAISE EXCEPTION 'Tournament not found.';
    END IF;

    -- Verify organizer key
    IF NOT public._verify_organizer(v_tournament_id, p_admin_token) THEN
        RAISE EXCEPTION 'Invalid organizer key.';
    END IF;

    -- Retrieve match details
    SELECT m.id, m.team_a_id, m.team_b_id, m.status, ta.name, tb.name
    INTO v_match_id, v_team_a_id, v_team_b_id, v_current_status, v_team_a_name, v_team_b_name
    FROM public.matches m
    LEFT JOIN public.teams ta ON ta.id = m.team_a_id
    LEFT JOIN public.teams tb ON tb.id = m.team_b_id
    WHERE m.tournament_id = v_tournament_id AND m.match_identifier = trim(p_match_identifier);

    IF v_match_id IS NULL THEN
        RAISE EXCEPTION 'Match % not found.', p_match_identifier;
    END IF;

    -- Requirement: Reject score updates when the match is already completed
    IF v_current_status = 'completed' THEN
        RAISE EXCEPTION 'Cannot update scores for a match that is already completed.';
    END IF;

    IF v_team_a_id IS NULL OR v_team_b_id IS NULL THEN
        RAISE EXCEPTION 'Match participants are not yet determined.';
    END IF;

    -- Validate sets JSON array
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
        -- To win a set, a team must reach at least the target AND lead by at least 2 points
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
        -- Match is currently in progress (e.g. 1 set completed)
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

-- Ensure execute permission on the updated function
GRANT EXECUTE ON FUNCTION public.rpc_update_match_score TO anon, authenticated;
