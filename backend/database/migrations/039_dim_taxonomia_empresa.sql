-- Migration 039: dim_taxonomia_empresa
-- Dicionário de taxonomia global para interconexão de empresas.
-- Pré-populada com setores e segmentos brasileiros.

CREATE TABLE IF NOT EXISTS dim_taxonomia_empresa (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  codigo TEXT UNIQUE NOT NULL,
  nome TEXT NOT NULL,
  nivel INT NOT NULL, -- 1=setor, 2=segmento, 3=nicho
  pai_id UUID REFERENCES dim_taxonomia_empresa(id),
  descricao TEXT,
  cnaes_relacionados TEXT[],
  palavras_chave TEXT[],
  sinonimos TEXT[],
  ativo BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_taxonomia_codigo ON dim_taxonomia_empresa(codigo);
CREATE INDEX IF NOT EXISTS idx_taxonomia_nivel ON dim_taxonomia_empresa(nivel);
CREATE INDEX IF NOT EXISTS idx_taxonomia_pai ON dim_taxonomia_empresa(pai_id);
CREATE INDEX IF NOT EXISTS idx_taxonomia_cnaes ON dim_taxonomia_empresa USING GIN(cnaes_relacionados);
CREATE INDEX IF NOT EXISTS idx_taxonomia_keywords ON dim_taxonomia_empresa USING GIN(palavras_chave);

-- Seed: Setores (nível 1)
INSERT INTO dim_taxonomia_empresa (codigo, nome, nivel, descricao, cnaes_relacionados) VALUES
('IND', 'Indústria', 1, 'Setor industrial e manufatura', ARRAY['10','11','12','13','14','15','16','17','18','19','20','21','22','23','24','25','26','27','28','29','30','31','32','33']),
('COM', 'Comércio', 1, 'Setor comercial atacado e varejo', ARRAY['45','46','47']),
('SER', 'Serviços', 1, 'Setor de serviços', ARRAY['35','36','37','38','39','49','50','51','52','53','55','56','58','59','60','61','62','63','64','65','66','68','69','70','71','72','73','74','75','77','78','79','80','81','82','84','85','86','87','88','90','91','92','93','94','95','96']),
('AGR', 'Agropecuária', 1, 'Agricultura, pecuária e extrativismo', ARRAY['01','02','03']),
('CON', 'Construção', 1, 'Construção civil e infraestrutura', ARRAY['41','42','43']),
('MIN', 'Mineração', 1, 'Indústrias extrativas', ARRAY['05','06','07','08','09'])
ON CONFLICT (codigo) DO NOTHING;

-- Seed: Segmentos (nível 2)
INSERT INTO dim_taxonomia_empresa (codigo, nome, nivel, pai_id, cnaes_relacionados, palavras_chave) VALUES
('IND.ALI', 'Alimentos e Bebidas', 2, (SELECT id FROM dim_taxonomia_empresa WHERE codigo='IND'), ARRAY['10','11'], ARRAY['alimento','bebida','food','drink','alimenticio']),
('IND.TEC', 'Tecnologia e Eletrônicos', 2, (SELECT id FROM dim_taxonomia_empresa WHERE codigo='IND'), ARRAY['26','27'], ARRAY['tecnologia','eletronico','hardware','chip','semicondutor']),
('IND.QUI', 'Químico e Farmacêutico', 2, (SELECT id FROM dim_taxonomia_empresa WHERE codigo='IND'), ARRAY['20','21'], ARRAY['quimico','farmaceutico','medicamento','farmacia']),
('IND.MET', 'Metalurgia e Siderurgia', 2, (SELECT id FROM dim_taxonomia_empresa WHERE codigo='IND'), ARRAY['24','25'], ARRAY['metal','aço','ferro','siderurgia','metalurgica']),
('IND.TEX', 'Têxtil e Vestuário', 2, (SELECT id FROM dim_taxonomia_empresa WHERE codigo='IND'), ARRAY['13','14'], ARRAY['textil','roupa','vestuario','confeccao','moda']),
('IND.AUT', 'Automotivo', 2, (SELECT id FROM dim_taxonomia_empresa WHERE codigo='IND'), ARRAY['29','30'], ARRAY['automovel','veiculo','carro','automotivo','peca']),
('IND.MAD', 'Madeira e Móveis', 2, (SELECT id FROM dim_taxonomia_empresa WHERE codigo='IND'), ARRAY['16','31'], ARRAY['madeira','movel','mobilia','marcenaria']),
('IND.PAP', 'Papel e Celulose', 2, (SELECT id FROM dim_taxonomia_empresa WHERE codigo='IND'), ARRAY['17','18'], ARRAY['papel','celulose','grafica','impressao']),
('IND.BOR', 'Borracha e Plástico', 2, (SELECT id FROM dim_taxonomia_empresa WHERE codigo='IND'), ARRAY['22'], ARRAY['borracha','plastico','polimero','embalagem']),
('IND.CER', 'Cerâmica e Vidro', 2, (SELECT id FROM dim_taxonomia_empresa WHERE codigo='IND'), ARRAY['23'], ARRAY['ceramica','vidro','cimento','concreto']),
('COM.VAR', 'Varejo', 2, (SELECT id FROM dim_taxonomia_empresa WHERE codigo='COM'), ARRAY['47'], ARRAY['varejo','loja','retail','store']),
('COM.ATA', 'Atacado', 2, (SELECT id FROM dim_taxonomia_empresa WHERE codigo='COM'), ARRAY['46'], ARRAY['atacado','distribuidor','wholesale']),
('COM.VEI', 'Veículos', 2, (SELECT id FROM dim_taxonomia_empresa WHERE codigo='COM'), ARRAY['45'], ARRAY['veiculo','concessionaria','automovel']),
('SER.TEC', 'Tecnologia da Informação', 2, (SELECT id FROM dim_taxonomia_empresa WHERE codigo='SER'), ARRAY['62','63'], ARRAY['software','sistema','ti','informatica','saas','app','desenvolvimento']),
('SER.FIN', 'Serviços Financeiros', 2, (SELECT id FROM dim_taxonomia_empresa WHERE codigo='SER'), ARRAY['64','65','66'], ARRAY['banco','fintech','seguro','credito','financeiro']),
('SER.SAU', 'Saúde', 2, (SELECT id FROM dim_taxonomia_empresa WHERE codigo='SER'), ARRAY['86','87','88'], ARRAY['saude','hospital','clinica','medico','health']),
('SER.EDU', 'Educação', 2, (SELECT id FROM dim_taxonomia_empresa WHERE codigo='SER'), ARRAY['85'], ARRAY['educacao','escola','universidade','ensino','curso']),
('SER.LOG', 'Logística e Transporte', 2, (SELECT id FROM dim_taxonomia_empresa WHERE codigo='SER'), ARRAY['49','50','51','52','53'], ARRAY['logistica','transporte','frete','entrega','shipping']),
('SER.JUR', 'Jurídico e Contábil', 2, (SELECT id FROM dim_taxonomia_empresa WHERE codigo='SER'), ARRAY['69'], ARRAY['advogado','juridico','contabil','contabilidade','escritorio']),
('SER.MKT', 'Marketing e Publicidade', 2, (SELECT id FROM dim_taxonomia_empresa WHERE codigo='SER'), ARRAY['73'], ARRAY['marketing','publicidade','propaganda','agencia','comunicacao']),
('SER.CON', 'Consultoria', 2, (SELECT id FROM dim_taxonomia_empresa WHERE codigo='SER'), ARRAY['70'], ARRAY['consultoria','consulting','gestao','management']),
('SER.ALO', 'Alimentação e Hospedagem', 2, (SELECT id FROM dim_taxonomia_empresa WHERE codigo='SER'), ARRAY['55','56'], ARRAY['restaurante','hotel','pousada','hospedagem','alimentacao']),
('SER.IMO', 'Imobiliário', 2, (SELECT id FROM dim_taxonomia_empresa WHERE codigo='SER'), ARRAY['68'], ARRAY['imovel','imobiliaria','aluguel','incorporacao']),
('SER.SEG', 'Segurança', 2, (SELECT id FROM dim_taxonomia_empresa WHERE codigo='SER'), ARRAY['80'], ARRAY['seguranca','vigilancia','monitoramento','alarme']),
('CON.EDI', 'Edificações', 2, (SELECT id FROM dim_taxonomia_empresa WHERE codigo='CON'), ARRAY['41'], ARRAY['edificacao','predio','residencial','comercial','incorporacao']),
('CON.INF', 'Infraestrutura', 2, (SELECT id FROM dim_taxonomia_empresa WHERE codigo='CON'), ARRAY['42'], ARRAY['infraestrutura','obra','rodovia','ponte','saneamento']),
('CON.SER', 'Serviços de Construção', 2, (SELECT id FROM dim_taxonomia_empresa WHERE codigo='CON'), ARRAY['43'], ARRAY['instalacao','eletrica','hidraulica','acabamento']),
('AGR.CUL', 'Cultivo e Plantio', 2, (SELECT id FROM dim_taxonomia_empresa WHERE codigo='AGR'), ARRAY['01'], ARRAY['agricultura','plantio','cultivo','soja','milho','cafe','safra']),
('AGR.PEC', 'Pecuária', 2, (SELECT id FROM dim_taxonomia_empresa WHERE codigo='AGR'), ARRAY['01'], ARRAY['pecuaria','gado','boi','frango','suino','leite']),
('AGR.PES', 'Pesca e Aquicultura', 2, (SELECT id FROM dim_taxonomia_empresa WHERE codigo='AGR'), ARRAY['03'], ARRAY['pesca','aquicultura','peixe','camarao','maricultura'])
ON CONFLICT (codigo) DO NOTHING;
