const express = require('express');
const mysql = require('mysql2');
const bodyParser = require('body-parser');
const app = express();

// Configurações do Express
app.set('view engine', 'ejs');
app.use(express.static('public'));
app.use(bodyParser.json()); 
app.use(bodyParser.urlencoded({ extended: true }));

// --- CONEXÃO COM O BANCO DE DADOS ---
const db = mysql.createConnection({
    host: 'localhost',
    user: 'root',
    password: 'wi8826@92', // Sua senha
    database: 'loja_sapatos'
});

db.connect((err) => {
    if (err) console.log("Erro MySQL: " + err);
    else console.log("✅ Conectado ao MySQL com sucesso!");
});

// Função auxiliar para usar Async/Await no Banco de Dados (Necessário para o Dashboard novo)
const queryAsync = (sql, params) => {
    return new Promise((resolve, reject) => {
        db.query(sql, params, (err, result) => {
            if (err) reject(err);
            else resolve(result);
        });
    });
};

// ==================================================
//               ROTAS DE TELAS (VIEWS)
// ==================================================

// 1. DASHBOARD EXECUTIVO (NOVO)
app.get('/', async (req, res) => {
    try {
        // 1. KPIs DO TOPO
        const sqlKPI = `
            SELECT 
                (SELECT COALESCE(SUM(total), 0) FROM vendas WHERE DATE(data_venda) = CURDATE()) as vendas_hoje,
                (SELECT COALESCE(SUM(total), 0) FROM vendas WHERE MONTH(data_venda) = MONTH(CURDATE()) AND YEAR(data_venda) = YEAR(CURDATE())) as vendas_mes,
                (SELECT COALESCE(AVG(total), 0) FROM vendas WHERE MONTH(data_venda) = MONTH(CURDATE())) as ticket_medio,
                (SELECT COUNT(*) FROM produtos) as total_produtos,
                (SELECT COUNT(*) FROM produtos WHERE estoque <= estoque_minimo) as estoque_critico
        `;

        // 2. Gráfico — Evolução 6 meses
        const sqlGraficoVendas = `
            SELECT DATE_FORMAT(data_venda, '%Y-%m') as mes, SUM(total) as total 
            FROM vendas WHERE data_venda >= DATE_SUB(NOW(), INTERVAL 6 MONTH)
            GROUP BY mes ORDER BY mes ASC
        `;

        // 3. Ranking — Top 5 produtos
        const sqlTopProdutos = `
            SELECT p.nome, SUM(iv.quantidade) as qtd_total 
            FROM itens_venda iv JOIN produtos p ON iv.id_produto = p.id
            GROUP BY p.id ORDER BY qtd_total DESC LIMIT 5
        `;

        // 4. Gráfico — Categorias
        const sqlCategorias = `
            SELECT c.nome, COUNT(v.id) as total_vendas
            FROM itens_venda iv
            JOIN produtos p ON iv.id_produto = p.id
            JOIN categorias c ON p.id_categoria = c.id
            JOIN vendas v ON iv.id_venda = v.id
            GROUP BY c.id
        `;

        // 5. Alertas e Últimas Vendas
        const sqlAlertas = "SELECT * FROM produtos WHERE estoque <= estoque_minimo ORDER BY estoque ASC LIMIT 5";
        const sqlUltimasVendas = "SELECT * FROM vendas ORDER BY id DESC LIMIT 5";

        // EXECUTAR TUDO EM PARALELO
        const [kpi, evolucaoVendas, topProdutos, categorias, alertas, ultimas] = await Promise.all([
            queryAsync(sqlKPI),
            queryAsync(sqlGraficoVendas),
            queryAsync(sqlTopProdutos),
            queryAsync(sqlCategorias),
            queryAsync(sqlAlertas),
            queryAsync(sqlUltimasVendas)
        ]);

        res.render('dashboard', {
            kpi: kpi[0] || {},
            charts: {
                meses: evolucaoVendas.map(x => x.mes),
                vendas: evolucaoVendas.map(x => x.total),
                prodNomes: topProdutos.map(x => x.nome),
                prodQtd: topProdutos.map(x => x.qtd_total),
                catNomes: categorias.map(x => x.nome),
                catQtd: categorias.map(x => x.total_vendas)
            },
            alertas: alertas || [],
            ultimas: ultimas || []
        });

    } catch (error) {
        console.log("Erro no Dashboard:", error);
        // Renderiza um dashboard vazio em caso de erro crítico para não travar
        res.render('dashboard', { kpi: {}, charts: { meses:[], vendas:[], prodNomes:[], prodQtd:[] }, alertas: [], ultimas: [] });
    }
});

// 2. GESTÃO DE ESTOQUE (Enterprise)
app.get('/produtos', (req, res) => {
    const sqlKPI = `
        SELECT 
            COUNT(*) as total_skus, SUM(estoque) as total_itens,
            SUM(estoque * preco_custo) as valor_estoque,
            (SELECT COUNT(*) FROM produtos WHERE estoque <= estoque_minimo) as alerta_baixo
        FROM produtos
    `;
    
    let sqlProdutos = "SELECT p.*, c.nome as categoria_nome FROM produtos p LEFT JOIN categorias c ON p.id_categoria = c.id";
    const termo = req.query.busca;
    if(termo) sqlProdutos += ` WHERE p.nome LIKE '%${termo}%' OR p.sku LIKE '%${termo}%'`;
    sqlProdutos += " ORDER BY p.id DESC";

    db.query(sqlKPI, (err, kpiResult) => {
        db.query("SELECT * FROM categorias", (err, cats) => {
            db.query(sqlProdutos, (err, produtos) => {
                res.render('produtos', { 
                    kpi: kpiResult ? kpiResult[0] : {}, 
                    categorias: cats || [], 
                    lista: produtos || [],
                    termoBusca: termo || ''
                });
            });
        });
    });
});

// 3. PDV PRO
app.get('/pdv-pro', (req, res) => {
    res.render('pdv_pro');
});

// 4. FINANCEIRO
app.get('/financeiro', (req, res) => {
    const sqlMovimentos = "SELECT * FROM caixa WHERE DATE(data_movimento) = CURDATE() ORDER BY id DESC";
    const sqlTotais = `
        SELECT 
            SUM(CASE WHEN tipo = 'ENTRADA' THEN valor ELSE 0 END) as total_entrada,
            SUM(CASE WHEN tipo = 'SAIDA' THEN valor ELSE 0 END) as total_saida
        FROM caixa WHERE DATE(data_movimento) = CURDATE()
    `;

    db.query(sqlMovimentos, (err, movimentos) => {
        db.query(sqlTotais, (err, totais) => {
            const entrada = totais[0].total_entrada || 0;
            const saida = totais[0].total_saida || 0;
            res.render('financeiro', { movimentos: movimentos || [], entrada, saida, saldo: entrada - saida });
        });
    });
});

// ==================================================
//           ROTAS DE AÇÃO (POST)
// ==================================================

// Salvar Produto
app.post('/salvar-produto', (req, res) => {
    const { nome, sku, categoria, tamanho, custo, venda, estoque, minimo, local, fornecedor } = req.body;
    
    const sql = `INSERT INTO produtos (nome, sku, id_categoria, tamanho, preco_custo, preco_venda, estoque, estoque_minimo, localizacao, fornecedor) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

    db.query(sql, [nome, sku, categoria, tamanho, custo, venda, estoque, minimo, local, fornecedor], (err, result) => {
        if(err) { console.log(err); return res.send("Erro ao cadastrar."); }
        
        const idProd = result.insertId;
        // Auditoria
        db.query(`INSERT INTO estoque_movimento (id_produto, tipo, quantidade, saldo_novo, motivo) VALUES (?, 'ENTRADA', ?, ?, 'Cadastro Inicial')`, [idProd, estoque, estoque]);
        // Financeiro
        db.query("INSERT INTO caixa (tipo, descricao, valor) VALUES ('SAIDA', ?, ?)", [`Compra Estoque - ${nome}`, custo * estoque]);

        res.redirect('/produtos');
    });
});

// Fechar Caixa
app.post('/fechar-caixa', (req, res) => {
    const { entrada, saida, saldo, obs } = req.body;
    db.query("INSERT INTO caixa_fechamento (total_entradas, total_saidas, saldo_final, observacoes) VALUES (?, ?, ?, ?)", [entrada, saida, saldo, obs], (err) => {
        res.redirect('/financeiro');
    });
});

// ==================================================
//               ROTAS DE API
// ==================================================

app.get('/api/buscar-produto', (req, res) => {
    const termo = req.query.q;
    let sql = "SELECT * FROM produtos";
    let params = [];
    if (termo) {
        sql += " WHERE nome LIKE ? OR sku LIKE ? OR id = ?";
        params = [`%${termo}%`, `%${termo}%`, termo];
    }
    sql += " LIMIT 20";
    db.query(sql, params, (err, results) => {
        if(err) return res.json([]);
        res.json(results);
    });
});

// --- CORREÇÃO DA ROTA DE FINALIZAR VENDA ---
app.post('/api/finalizar-venda', (req, res) => {
    const { 
        vendedor, itens, total_final, pagamento, 
        desconto, frete, transportadora, data_entrega, observacoes 
    } = req.body;

    if (!itens || itens.length === 0) {
        return res.status(400).json({ erro: "Carrinho vazio" });
    }

    // CORREÇÃO: Se a data vier vazia "", transformar em NULL para o banco aceitar
    const dataEntregaTratada = data_entrega === "" ? null : data_entrega;

    const sqlVenda = `
        INSERT INTO vendas 
        (vendedor, total, forma_pagamento, desconto, frete, transportadora, data_entrega, observacoes, status) 
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'FECHADO')
    `;

    // Note que usamos 'dataEntregaTratada' agora
    db.query(sqlVenda, [vendedor, total_final, pagamento, desconto, frete, transportadora, dataEntregaTratada, observacoes], (err, resultVenda) => {
        if (err) {
            console.log("ERRO NO SQL VENDA:", err); // Isso vai mostrar o erro real no terminal
            return res.status(500).json({ erro: "Erro no banco de dados" });
        }
        
        const idVenda = resultVenda.insertId;

        // Salvar Itens
        itens.forEach(item => {
            db.query("INSERT INTO itens_venda (id_venda, id_produto, quantidade, subtotal, desconto_item) VALUES (?, ?, ?, ?, ?)",
                [idVenda, item.id, item.qtd, item.subtotal, item.desconto || 0]);
            
            // Baixa estoque
            db.query("UPDATE produtos SET estoque = estoque - ? WHERE id = ?", [item.qtd, item.id]);
        });

        // Lança no Caixa
        db.query("INSERT INTO caixa (tipo, descricao, valor) VALUES ('ENTRADA', ?, ?)",
            [`Venda #${idVenda} (${pagamento})`, total_final]);

        res.json({ sucesso: true, id_venda: idVenda });
    });
});
// INICIAR SERVIDOR
app.listen(3000, () => {
    console.log("--------------------------------------------------");
    console.log("🚀 SISTEMA LOJA SAPATOS (ENTERPRISE) RODANDO!");
    console.log("👉 Acesse: http://localhost:3000");
    console.log("--------------------------------------------------");
});