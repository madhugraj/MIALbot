CREATE OR REPLACE FUNCTION public.execute_sql_query(query_text text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
    result_json JSONB;
BEGIN
    EXECUTE format('SELECT jsonb_agg(to_jsonb(t)) FROM (%s) t', query_text) INTO result_json;
    RETURN COALESCE(result_json, '[]'::jsonb); -- Return empty array if no results
END;
$$;