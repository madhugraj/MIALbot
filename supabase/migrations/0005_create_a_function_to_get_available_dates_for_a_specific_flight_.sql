CREATE OR REPLACE FUNCTION get_available_dates_for_flight(
    p_airline_code TEXT,
    p_flight_number TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
    result_json JSONB;
BEGIN
    SELECT jsonb_agg(DISTINCT TO_CHAR(origin_date_time, 'YYYY-MM-DD'))
    INTO result_json
    FROM public.flight_schedule
    WHERE 
        (p_airline_code IS NULL OR airline_code ILIKE p_airline_code)
        AND (p_flight_number IS NULL OR flight_number ILIKE p_flight_number)
    LIMIT 5;

    RETURN COALESCE(result_json, '[]'::jsonb);
END;
$$;