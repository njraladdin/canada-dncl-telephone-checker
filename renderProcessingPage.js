const clc = require('cli-color');

async function renderProcessingResults(db, req) {
    // Get page number from query parameters
    const page = parseInt(req.query.page) || 1;
    const perPage = 50;
    const offset = (page - 1) * perPage;

    // Get total counts and progress
    const counts = await db.getDb().get(`
        SELECT 
            COUNT(*) as total,
            COUNT(CASE WHEN dncl_status IN ('ACTIVE', 'INACTIVE', 'INVALID') THEN 1 END) as processed
        FROM numbers
        WHERE telephone IS NOT NULL 
        AND phone_type = 'MOBILE'
    `);

    // Calculate progress percentage
    const progressPercentage = counts.total > 0 
        ? ((counts.processed / counts.total) * 100).toFixed(1) 
        : 0;

    // Get total pages for pagination
    const totalRecords = await db.getDb().get(
        'SELECT COUNT(*) as count FROM numbers WHERE dncl_checked_at IS NOT NULL AND dncl_status IS NOT NULL'
    );
    const totalPages = Math.ceil(totalRecords.count / perPage);

    // Get paginated results
    const rows = await db.getDb().all(`
        SELECT 
            nom, 
            prenom, 
            telephone, 
            LOWER(dncl_status) as dncl_status, 
            DNCL_registration_date, 
            dncl_checked_at
        FROM numbers 
        WHERE dncl_checked_at IS NOT NULL
        AND dncl_status IS NOT NULL
        ORDER BY dncl_checked_at DESC
        LIMIT ? OFFSET ?
    `, [perPage, offset]);

    console.log('Sample row:', rows[0]);

    function formatDate(dateString) {
        if (!dateString) return '-';
        return new Date(dateString).toLocaleDateString('en-CA', {
            year: 'numeric',
            month: 'short',
            day: 'numeric',
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit',
            hour12: false // Use 24-hour format
        });
    }

    // After the counts query, add this new query
    const statusCounts = await db.getDb().all(`
        SELECT 
            LOWER(dncl_status) as status,
            COUNT(*) as count
        FROM numbers
        WHERE dncl_status IS NOT NULL
        GROUP BY dncl_status
        ORDER BY count DESC
    `);

    // After getting statusCounts, let's create a dynamic color mapping
    const statusColorMap = {
        'active': '#ff6b6b',
        'inactive': '#51cf66',
        'invalid': '#ff8787',
        'error': '#ffd43b',
        'processing': '#74c0fc',
        'pending': '#adb5bd'
    };

    // Log the existing statuses to see what we have
    console.log('Existing statuses:', statusCounts.map(item => item.status));

    // Return HTML template
    return `
        <!DOCTYPE html>
        <html data-bs-theme="dark">
        <head>
            <title>DNCL Processing Results</title>
            <link href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.0/dist/css/bootstrap.min.css" rel="stylesheet">
            <style>
                body {
                    background-color: #212529;
                    color: #e9ecef;
                }
                .table-container { margin: 20px; }
                .pagination-container { margin: 20px; }
                .status-active { color: #ff6b6b !important; font-weight: bold; }
                .status-inactive { color: #51cf66 !important; font-weight: bold; }
                .status-error { color: #ffd43b !important; }
                .status-invalid { color: #ff8787 !important; }
                .status-processing { color: #74c0fc !important; }
                .status-pending { color: #adb5bd !important; }
                .progress { 
                    height: 25px;
                    background-color: #343a40;
                }
                .table {
                    color: #e9ecef;
                }
                .card {
                    background-color: #343a40;
                    border-color: #495057;
                }
                .page-link {
                    background-color: #343a40;
                    border-color: #495057;
                    color: #e9ecef;
                }
                .page-link:hover {
                    background-color: #495057;
                    border-color: #6c757d;
                    color: #fff;
                }
                .page-item.active .page-link {
                    background-color: #0d6efd;
                    border-color: #0d6efd;
                }
                .card canvas {
                    max-height: 300px;
                    width: 100% !important;
                    margin: 20px 0;
                }
            </style>
        </head>
        <body>
            <div class="table-container">
                <h2>DNCL Processing Results</h2>
                
                <div class="card mb-4">
                    <div class="card-body">
                        <h5 class="card-title">Processing Progress</h5>
                        <div class="progress mb-3">
                            <div class="progress-bar" role="progressbar" 
                                 style="width: ${progressPercentage}%;" 
                                 aria-valuenow="${progressPercentage}" 
                                 aria-valuemin="0" 
                                 aria-valuemax="100">
                                ${progressPercentage}%
                            </div>
                        </div>
                        <p class="card-text">
                            Processed: ${counts.processed} out of ${counts.total} numbers
                        </p>
                    </div>
                </div>

                <div class="card mb-4">
                    <div class="card-body">
                        <h5 class="card-title">Status Distribution</h5>
                        <canvas id="statusChart"></canvas>
                    </div>
                </div>

                <table class="table table-striped table-hover">
                    <thead>
                        <tr>
                            <th>Name</th>
                            <th>Phone</th>
                            <th>Status</th>
                            <th>Registration Date</th>
                            <th>Checked At</th>
                        </tr>
                    </thead>
                    <tbody>
                        ${rows.map(row => `
                            <tr>
                                <td>${row.prenom} ${row.nom}</td>
                                <td>${row.telephone}</td>
                                <td class="status-${row.dncl_status || 'pending'}">
                                    ${(row.dncl_status || 'PENDING').toUpperCase()}
                                </td>
                                <td>${formatDate(row.DNCL_registration_date)}</td>
                                <td>${formatDate(row.dncl_checked_at)}</td>
                            </tr>
                        `).join('')}
                    </tbody>
                </table>
                
                <div class="pagination-container">
                    <nav>
                        <ul class="pagination">
                            ${page > 1 ? `
                                <li class="page-item">
                                    <a class="page-link" href="?page=${page - 1}">Previous</a>
                                </li>
                            ` : ''}
                            
                            ${Array.from(
                                { length: Math.min(5, totalPages) },
                                (_, i) => Math.max(1, Math.min(page - 2 + i, totalPages))
                            ).map(p => `
                                <li class="page-item ${p === page ? 'active' : ''}">
                                    <a class="page-link" href="?page=${p}">${p}</a>
                                </li>
                            `).join('')}
                            
                            ${page < totalPages ? `
                                <li class="page-item">
                                    <a class="page-link" href="?page=${page + 1}">Next</a>
                                </li>
                            ` : ''}
                        </ul>
                    </nav>
                </div>
            </div>

            <script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
            <script>
                const ctx = document.getElementById('statusChart');
                const statuses = ${JSON.stringify(statusCounts.map(item => item.status))};
                const colorMap = ${JSON.stringify(statusColorMap)};
                
                new Chart(ctx, {
                    type: 'bar',
                    data: {
                        labels: statuses.map(status => status.toUpperCase()),
                        datasets: [{
                            label: 'Number of Records',
                            data: ${JSON.stringify(statusCounts.map(item => item.count))},
                            backgroundColor: statuses.map(status => colorMap[status] || '#adb5bd'), // fallback to gray if no color defined
                            borderWidth: 1
                        }]
                    },
                    options: {
                        responsive: true,
                        scales: {
                            y: {
                                beginAtZero: true,
                                grid: {
                                    color: '#495057'
                                },
                                ticks: {
                                    color: '#e9ecef'
                                }
                            },
                            x: {
                                grid: {
                                    color: '#495057'
                                },
                                ticks: {
                                    color: '#e9ecef'
                                }
                            }
                        },
                        plugins: {
                            legend: {
                                labels: {
                                    color: '#e9ecef'
                                }
                            }
                        }
                    }
                });
            </script>
        </body>
        </html>
    `;
}

module.exports = renderProcessingResults; 