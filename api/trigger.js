const INTEGRATOR_API_URL = process.env.INTEGRATOR_API_URL || 'https://integrations-api.composio.io';
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

const sbHeaders = {
    'apikey': SUPABASE_SERVICE_KEY,
    'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
    'Content-Type': 'application/json',
    'Prefer': 'return=minimal'
};

async function sbSelect(table, filters = '') {
    const hasSelect = filters.includes('select=');
    const url = `${SUPABASE_URL}/rest/v1/${table}?${hasSelect ? '' : 'select=*&'}${filters}`;
    const resp = await fetch(url, { headers: sbHeaders });
    if (!resp.ok) {
        console.error(`sbSelect ${table} failed:`, resp.status, await resp.text());
        return [];
    }
    const data = await resp.json();
    return Array.isArray(data) ? data : [];
}

async function sbInsert(table, data) {
    const url = `${SUPABASE_URL}/rest/v1/${table}`;
    const resp = await fetch(url, {
        method: 'POST',
        headers: sbHeaders,
        body: JSON.stringify(data)
    });
    if (!resp.ok) {
        const err = await resp.text();
        console.error(`sbInsert ${table} failed:`, err);
        throw new Error(`Insert into ${table} failed: ${err}`);
    }
}

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
        const {
            app_name,
            connection_id,
            environment,
            finder_instructions,
            test_all_actions
        } = req.body;

        if (!app_name) {
            return res.status(400).json({ error: 'Missing required field: app_name' });
        }

        const normalizedEnv = environment === 'staging' ? 'staging' : 'production';

        // Check if already running for this app
        const activeRuns = await sbSelect(
            'ca_workflow_runs',
            'status=eq.active&select=*,ca_workflows!inner(app_name)&ca_workflows.app_name=eq.' + encodeURIComponent(app_name)
        );

        if (activeRuns.length > 0) {
            return res.status(409).json({
                error: 'already_running',
                message: `A workflow is already running for ${app_name}`,
                workflow_id: activeRuns[0].workflow_id
            });
        }

        // Check concurrency
        const allActive = await sbSelect('ca_workflow_runs', 'status=eq.active');
        const configRows = await sbSelect('ca_config', 'key=eq.max_concurrent');
        const maxConcurrent = configRows.length > 0 ? configRows[0].value : 8;
        const activeCount = allActive.length;

        // Build API payload
        const payload = {
            model_provider: 'claude',
            force_run: true,
            timeout_hours: 36,
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
        if (finder_instructions) {
            payload.finder_instructions = finder_instructions;
        }
        if (test_all_actions) {
            payload.test_all_actions = true;
        }

        // If at capacity, queue it
        if (activeCount >= maxConcurrent) {
            const queueItems = await sbSelect('ca_queued_workflows', 'order=position.desc&limit=1');
            const nextPosition = (queueItems.length > 0 && queueItems[0].position != null)
                ? queueItems[0].position + 1
                : 1;

            await sbInsert('ca_queued_workflows', {
                payload: payload,
                app_name: app_name,
                connection_id: connection_id || null,
                position: nextPosition
            });

            return res.status(200).json({
                queued: true,
                position: nextPosition,
                message: `Workflow queued at position ${nextPosition} (${activeCount}/${maxConcurrent} running)`
            });
        }

        // Trigger workflow via Integrator API
        console.log('Triggering create-app workflow for:', app_name);

        const apiResponse = await fetch(`${INTEGRATOR_API_URL}/workflows/create-app/run`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });

        const apiResult = await apiResponse.json();
        console.log('Integrator API response:', JSON.stringify(apiResult, null, 2));

        if (!apiResponse.ok || !apiResult.workflow_id) {
            // Store the failed trigger so it's visible on the dashboard
            const errorMsg = apiResult.message || apiResult.error || 'No workflow_id returned';
            const failId = `fail_${Date.now().toString(36)}`;
            try {
                await sbInsert('ca_workflows', {
                    workflow_id: failId,
                    app_name: app_name,
                    connection_id: connection_id || null,
                    environment: normalizedEnv
                });
                await sbInsert('ca_workflow_runs', {
                    workflow_id: failId,
                    run_number: 1,
                    status: 'completed',
                    execution_state: 'TRIGGER_FAILED',
                    failure_summary: errorMsg,
                    started_at: new Date().toISOString(),
                    completed_at: new Date().toISOString()
                });
            } catch (dbErr) {
                console.error('Failed to store trigger failure:', dbErr);
            }

            return res.status(500).json({
                error: 'Failed to trigger workflow',
                details: errorMsg,
                api_response: apiResult,
                http_status: apiResponse.status
            });
        }

        // Insert into Supabase
        await sbInsert('ca_workflows', {
            workflow_id: apiResult.workflow_id,
            app_name: app_name,
            connection_id: connection_id || null,
            environment: normalizedEnv
        });

        await sbInsert('ca_workflow_runs', {
            workflow_id: apiResult.workflow_id,
            run_number: apiResult.run_number || 1,
            status: 'active',
            execution_state: 'PENDING',
            started_at: new Date().toISOString()
        });

        return res.status(200).json({
            success: true,
            workflow_id: apiResult.workflow_id,
            run_number: apiResult.run_number || 1,
            app_name: app_name
        });

    } catch (error) {
        console.error('Trigger error:', error);
        return res.status(500).json({ error: error.message });
    }
}
