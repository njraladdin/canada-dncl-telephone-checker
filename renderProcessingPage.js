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
            COUNT(CASE WHEN dncl_status IS NOT NULL THEN 1 END) as processed
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
        'SELECT COUNT(*) as count FROM numbers WHERE dncl_checked_at IS NOT NULL'
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
        ORDER BY dncl_checked_at DESC
        LIMIT ? OFFSET ?
    `, [perPage, offset]);

    console.log('Sample row:', rows[0]);

    function formatDate(dateString) {
        if (!dateString) return '-';
        return new Date(dateString).toLocaleDateString('en-CA', {
            year: 'numeric',
            month: 'short',
            day: 'numeric'
        });
    }

    // Return HTML template
    return `
        <!DOCTYPE html>
        <html>
        <head>
            <title>DNCL Processing Results</title>
            <link href="https://cdn.jsdelivr.net/npm/bootstrap@5.1.3/dist/css/bootstrap.min.css" rel="stylesheet">
            <style>
                .table-container { margin: 20px; }
                .pagination-container { margin: 20px; }
                .status-active { color: red !important; font-weight: bold; }
                .status-inactive { color: green !important; font-weight: bold; }
                .status-error { color: orange !important; }
                .status-invalid { color: gray !important; }
                .status-processing { color: blue !important; }
                .status-pending { color: #666 !important; }
                .progress { height: 25px; }
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
        </body>
        </html>
    `;
}

module.exports = renderProcessingResults; 