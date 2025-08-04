import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.0';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const { user_query } = await req.json();

    const supabase = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_ANON_KEY') ?? '',
      {
        global: {
          headers: { 'x-my-custom-header': 'Supabase-Edge-Function' },
        },
      }
    );

    let sqlQuery = '';
    let naturalLanguageResponse = '';

    // --- START: Placeholder for LLM-based SQL generation ---
    // In a real application, an LLM (e.g., Gemini) would be used here
    // to convert `user_query` into a SQL query based on the `flight_schedule` schema.
    // For demonstration, we'll hardcode a response for a specific query.

    if (user_query.toLowerCase().includes("indigo flights from mumbai to delhi today")) {
      sqlQuery = `SELECT flight_number, airline_name, departure_airport_name, arrival_airport_name, scheduled_departure_time, estimated_departure_time, actual_departure_time, terminal_name, gate_name, operational_status_description FROM flight_schedule WHERE airline_name ILIKE '%Indigo%' AND departure_airport_name ILIKE '%Mumbai%' AND arrival_airport_name ILIKE '%Delhi%' AND scheduled_departure_time::date = CURRENT_DATE ORDER BY scheduled_departure_time DESC LIMIT 10;`;
    } else if (user_query.toLowerCase().includes("delayed flights from bangalore")) {
      sqlQuery = `SELECT flight_number, airline_name, departure_airport_name, arrival_airport_name, scheduled_departure_time, estimated_departure_time, actual_departure_time, terminal_name, gate_name, operational_status_description FROM flight_schedule WHERE departure_airport_name ILIKE '%Bangalore%' AND operational_status_description ILIKE '%Delayed%' ORDER BY scheduled_departure_time DESC LIMIT 10;`;
    }
    else {
      naturalLanguageResponse = "I can only answer specific queries about flight schedules, such as 'Show all Indigo flights from Mumbai to Delhi today' or 'List delayed flights from Bangalore'.";
    }
    // --- END: Placeholder for LLM-based SQL generation ---

    if (sqlQuery) {
      const { data, error } = await supabase.rpc('execute_sql_query', { query_text: sqlQuery });

      if (error) {
        console.error('SQL Execution Error:', error);
        naturalLanguageResponse = `I encountered an error while fetching data: ${error.message}.`;
      } else if (data && data.length > 0) {
        // Format the results into a natural language response
        naturalLanguageResponse = "Here are the flights I found:\n\n";
        data.forEach((row: any) => {
          naturalLanguageResponse += `Flight ${row.flight_number} (${row.airline_name}) from ${row.departure_airport_name} to ${row.arrival_airport_name}. Scheduled: ${new Date(row.scheduled_departure_time).toLocaleString()}. Status: ${row.operational_status_description || 'N/A'}.\n`;
        });
      } else {
        naturalLanguageResponse = "No flights found matching your criteria.";
      }
    }

    return new Response(JSON.stringify({ response: naturalLanguageResponse }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      status: 200,
    });

  } catch (error) {
    console.error('Edge Function Error:', error);
    return new Response(JSON.stringify({ error: error.message }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      status: 500,
    });
  }
});