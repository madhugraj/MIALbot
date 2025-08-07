CREATE OR REPLACE FUNCTION public.execute_sql_query(query_text text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
    result_json JSONB;
BEGIN
    IF lower(ltrim(query_text)) NOT LIKE 'select%' THEN
        RAISE EXCEPTION 'Query execution failed: Only SELECT queries are permitted.';
    END IF;

    EXECUTE format('SELECT jsonb_agg(to_jsonb(t)) FROM (%s) t', query_text)
    INTO result_json;

    RETURN COALESCE(result_json, '[]'::jsonb);
END;
$function$