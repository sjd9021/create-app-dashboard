const INTEGRATOR_API_URL = process.env.INTEGRATOR_API_URL || 'https://integrations-api.composio.io';
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

const sbHeaders = {
    'apikey': SUPABASE_SERVICE_KEY,
    'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
    'Content-Type': 'application/json',
    'Prefer': 'return=minimal'
};

export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
        return res.status(200).end();
    }

    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method not allowed' });
    }

    try {
        const { app_name, workflow_id, connection_id, environment } = req.body;

        if (!app_name || !workflow_id) {
            return res.status(400).json({ error: 'Missing required fields (app_name, workflow_id)' });
        }

        const normalizedEnv = environment === 'staging' ? 'staging' : 'production';

        // Build payload — uses previous_workflow_id for rerun
        const payload = {
            model_provider: 'claude',
            force_run: true,
            timeout_hours: 36,
            previous_workflow_id: workflow_id,
            env: normalizedEnv,
            integrator_branch: 'next',
            app_name: app_name,
            base_branch: 'master',
            labels: [],
            slack_thread_id: '',
            feature_flags: {
                tracing_enable_workflow_span: false,
                debug_logs: false,
                max_parallel_agents: 40,
                ecs_cpu_override: null,
                ecs_memory_override: null
            }
        };

        if (connection_id) {
            payload.connection_id = connection_id;
        }

        console.log('Retrying create-app workflow:', JSON.stringify(payload, null, 2));

        const apiResponse = await fetch(`${INTEGRATOR_API_URL}/workflows/create-app/run`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });

        const apiResult = await apiResponse.json();
        console.log('Integrator API response:', JSON.stringify(apiResult, null, 2));

        if (!apiResponse.ok || !apiResult.workflow_id) {
            return res.status(500).json({
                error: 'Failed to trigger rerun',
                details: apiResult.message || apiResult.error || 'No workflow_id returned',
                api_response: apiResult,
                http_status: apiResponse.status
            });
        }

        // Insert ca_workflows record if API returned a new workflow_id
        if (apiResult.workflow_id !== workflow_id) {
            const wfResp = await fetch(`${SUPABASE_URL}/rest/v1/ca_workflows`, {
                method: 'POST',
                headers: sbHeaders,
                body: JSON.stringify({
                    workflow_id: apiResult.workflow_id,
                    app_name: app_name,
                    connection_id: connection_id || null,
                    environment: normalizedEnv
                })
            });
            if (!wfResp.ok) {
                console.error('Failed to insert ca_workflows:', await wfResp.text());
            }
        }

        // Get current max run_number for this workflow
        let newRunNumber = apiResult.run_number || 1;
        try {
            const runsResp = await fetch(
                `${SUPABASE_URL}/rest/v1/ca_workflow_runs?workflow_id=eq.${encodeURIComponent(workflow_id)}&select=run_number&order=run_number.desc&limit=1`,
                { headers: sbHeaders }
            );
            if (runsResp.ok) {
                const runs = await runsResp.json();
                if (Array.isArray(runs) && runs.length > 0) {
                    newRunNumber = apiResult.run_number || ((runs[0].run_number || 0) + 1);
                }
            }
        } catch (e) {
            console.error('Failed to fetch run numbers:', e);
        }

        // Insert new run
        const runResp = await fetch(`${SUPABASE_URL}/rest/v1/ca_workflow_runs`, {
            method: 'POST',
            headers: sbHeaders,
            body: JSON.stringify({
                workflow_id: apiResult.workflow_id,
                run_number: newRunNumber,
                status: 'active',
                execution_state: 'PENDING',
                started_at: new Date().toISOString()
            })
        });
        if (!runResp.ok) {
            console.error('Failed to insert ca_workflow_runs:', await runResp.text());
        }

        return res.status(200).json({
            success: true,
            workflow_id: apiResult.workflow_id,
            run_number: newRunNumber,
            app_name: app_name
        });

    } catch (error) {
        console.error('Retry error:', error);
        return res.status(500).json({ error: error.message });
    }
}
