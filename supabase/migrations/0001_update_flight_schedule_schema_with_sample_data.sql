DO $$
DECLARE
    sample_row_json JSONB;
    existing_schema_json JSONB;
    new_schema_json JSONB;
BEGIN
    -- 1. Get a sample row from the flight_schedule table
    SELECT to_jsonb(t)
    INTO sample_row_json
    FROM (SELECT * FROM public.flight_schedule LIMIT 1) t;

    -- 2. Get the existing schema from the metadata table
    SELECT schema_json
    INTO existing_schema_json
    FROM public.schema_metadata
    WHERE table_name = 'flight_schedule';

    -- 3. Combine them into a new JSON object, avoiding nesting if run multiple times
    IF jsonb_path_exists(existing_schema_json, '$.schema') THEN
        -- It's already in the new format, just update the sample_data part
        new_schema_json := jsonb_set(existing_schema_json, '{sample_data}', sample_row_json);
    ELSE
        -- It's in the old format, create the new structure
        new_schema_json := jsonb_build_object(
            'schema', existing_schema_json,
            'sample_data', sample_row_json
        );
    END IF;

    -- 4. Update the metadata table with the new combined JSON
    UPDATE public.schema_metadata
    SET schema_json = new_schema_json
    WHERE table_name = 'flight_schedule';

    RAISE NOTICE 'Successfully updated schema_metadata for flight_schedule with sample data.';
END;
$$;