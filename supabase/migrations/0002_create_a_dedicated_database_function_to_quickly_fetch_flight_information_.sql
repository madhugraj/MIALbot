CREATE OR REPLACE FUNCTION get_flight_info(
    p_airline_code TEXT DEFAULT NULL,
    p_flight_number TEXT DEFAULT NULL,
    p_origin_date DATE DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
    result_json JSONB;
BEGIN
    SELECT jsonb_agg(to_jsonb(t))
    INTO result_json
    FROM (
        SELECT 
            airline_code,
            flight_number,
            flight_schedule_type,
            operational_status_description,
            departure_airport_name,
            arrival_airport_name,
            scheduled_departure_time,
            estimated_departure_time,
            actual_departure_time,
            scheduled_arrival_time,
            estimated_arrival_time,
            actual_arrival_time,
            gate_name,
            terminal_name,
            delay_duration,
            remark_free_text
        FROM public.flight_schedule
        WHERE 
            (p_airline_code IS NULL OR airline_code ILIKE '%' || p_airline_code || '%')
            AND (p_flight_number IS NULL OR flight_number ILIKE '%' || p_flight_number || '%')
            AND (p_origin_date IS NULL OR DATE(origin_date_time) = p_origin_date)
        LIMIT 10
    ) t;

    RETURN COALESCE(result_json, '[]'::jsonb);
END;
$$;